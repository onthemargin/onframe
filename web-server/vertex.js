'use strict';

const SYSTEM_PROMPT = `You are a senior portrait photographer giving honest critique a beginner can act on. The output renders inside small mobile cards — be terse.

Input: a portrait photo + a JSON of locally-measured numbers (treat as authoritative for sharpness/framing/crop).

Output ONLY a JSON object (no markdown, no commentary):

{
  "aiSummary": "<MAX 200 chars. Two short sentences. Lead with the biggest issue. End with one genuine strength. State things directly — no 'consider' / 'try' / 'might'.>",
  "perceptualFindings": {
    "lighting":     { "delta": <integer -10..10>, "reason": "<MAX 70 chars. One short observation naming the specific thing.>" },
    "composition":  { "delta": <integer -10..10>, "reason": "<MAX 70 chars>" },
    "background":   { "delta": <integer -10..10>, "reason": "<MAX 70 chars>" },
    "eyecontact":   { "delta": <integer -10..10>, "reason": "<MAX 70 chars>" },
    "headpose":     { "delta": <integer  -5..5>,  "reason": "<MAX 70 chars>" }
  }
}

Calibration:
  +8/+10 : exceptional. Rare.
  +3/+5  : noticeably better than baseline.
  0/+1   : on par with baseline.
  -3/-5  : noticeable problem a viewer registers.
  -8/-10 : serious issue dominating perception.

Rules:
- Return a delta for ALL FIVE categories. No silent omissions.
- Numbers are plain integers, no leading '+' sign.
- Reasons name the specific thing visible (the flag, shadow under chin, cropped fingertip, lens glare). No generic praise ("engaging" / "natural" / "warm"). No hedging ("could" / "might" / "consider").
- Be as willing to deduct as to add. Average photo nets near zero.
- Beginner vocabulary — no "Rembrandt", no f-stops, no clock positions.

Good reasons (this length, this specificity):
- "Hard shadow cuts across cheek from overhead key."
- "Top of head clipped; eyeline sits too low."
- "Reflection in right lens pulls focus from eye."
- "Hands at wrist read tense, not relaxed."

Bad reasons (DO NOT write these):
- "Natural and engaging." (no cause)
- "The lighting is flat and creates distinct shadows under the chin and nose, lacking dimension." (too long; one observation should be ~50 chars)`;

const VERTEX_TIMEOUT_MS = 25_000;
const MAX_AI_SUMMARY_LENGTH = 220;
const DEFAULT_MODEL = 'gemini-2.5-flash';

function stripCodeFences(text) {
  if (typeof text !== 'string') return text;
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  if (fence) return fence[1].trim();
  return trimmed;
}

function buildPrompt(metricsText) {
  return `${SYSTEM_PROMPT}

Local measurement payload (JSON):
${metricsText}

Now analyze the attached photo and return the JSON object described above.`;
}

// Gemini response schema. Schema-enforced JSON dramatically reduces parse
// failures vs responseMimeType alone — Gemini guarantees a JSON object of
// this exact shape with valid types.
const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    delta: { type: 'integer' },
    reason: { type: 'string' },
  },
  required: ['delta', 'reason'],
};
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    aiSummary: { type: 'string' },
    perceptualFindings: {
      type: 'object',
      properties: {
        lighting: FINDING_SCHEMA,
        composition: FINDING_SCHEMA,
        background: FINDING_SCHEMA,
        eyecontact: FINDING_SCHEMA,
        headpose: FINDING_SCHEMA,
      },
      required: ['lighting', 'composition', 'background', 'eyecontact', 'headpose'],
    },
  },
  required: ['aiSummary', 'perceptualFindings'],
};

function buildRequestBody({ photoBuffer, metricsText, photoMimeType }) {
  const mimeType = photoMimeType || 'image/jpeg';
  const base64Image = photoBuffer.toString('base64');
  const promptText = buildPrompt(metricsText);

  return {
    contents: [
      {
        role: 'user',
        parts: [
          { text: promptText },
          { inlineData: { mimeType, data: base64Image } },
        ],
      },
    ],
    generationConfig: {
      // Low temperature + fixed seed: near-deterministic output across runs.
      // The eval harness saw stddev > 2 on 4/5 categories at temperature 0.3;
      // dropping to 0.1 with seed=1 collapses run-to-run variance for the
      // same photo to a tight range.
      temperature: 0.1,
      seed: 1,
      // 4096 caps output budget so a verbose reason can't truncate the JSON.
      // Pricing is per actual output so a higher cap costs nothing when the
      // response is short; saw a parse failure at 2048 ("Unterminated string
      // at position 255") that this prevents.
      maxOutputTokens: 4096,
      topP: 0.95,
      responseMimeType: 'application/json',
      // responseSchema is the real fix for ~20% parse failures the eval
      // harness measured: Gemini enforces structure + integer types, so
      // truncated/malformed outputs become essentially impossible.
      responseSchema: RESPONSE_SCHEMA,
    },
  };
}

function extractContent(generateContentResponse) {
  const candidates = generateContentResponse?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('Vertex response missing candidates');
  }
  const parts = candidates[0]?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error('Vertex response missing content parts');
  }
  const text = parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
  if (!text.trim()) {
    throw new Error('Vertex response missing text content');
  }
  return text;
}

// Gemini occasionally writes "+3" (explicit sign) instead of "3" inside the
// JSON object even when the prompt forbids it. Strip the leading + on numbers
// after a JSON-position marker so JSON.parse succeeds.
function stripPlusSignedIntegers(text) {
  return text.replace(/([:\[,\s])\+(\d)/g, '$1$2');
}

function parseVertexOutput(rawContent) {
  if (typeof rawContent !== 'string' || !rawContent.trim()) {
    throw new Error('Vertex returned empty content');
  }
  const stripped = stripPlusSignedIntegers(stripCodeFences(rawContent));
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new Error(`Vertex output is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Vertex output is not an object');
  }
  const aiSummary = parsed.aiSummary;
  if (typeof aiSummary !== 'string' || !aiSummary.trim()) {
    throw new Error('Vertex output missing aiSummary');
  }
  if (aiSummary.length > MAX_AI_SUMMARY_LENGTH) {
    throw new Error('Vertex aiSummary exceeds maximum length');
  }
  const result = { aiSummary: aiSummary.trim() };
  if (parsed.perceptualFindings && typeof parsed.perceptualFindings === 'object') {
    result.perceptualFindings = parsed.perceptualFindings;
  }
  return result;
}

async function defaultGetAccessToken() {
  const { GoogleAuth } = require('google-auth-library');
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  const token = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token;
  if (!token) throw new Error('Failed to obtain Vertex AI access token');
  return token;
}

function createVertexClient({
  project,
  location,
  model = DEFAULT_MODEL,
  getAccessToken = defaultGetAccessToken,
  fetchImpl = global.fetch,
} = {}) {
  if (!project) throw new Error('createVertexClient: project is required');
  if (!location) throw new Error('createVertexClient: location is required');
  if (!model) throw new Error('createVertexClient: model is required');

  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;

  async function analyze({ photoBuffer, metricsText, photoMimeType }) {
    if (!Buffer.isBuffer(photoBuffer) || photoBuffer.length === 0) {
      throw new Error('analyze: photoBuffer is required');
    }
    if (typeof metricsText !== 'string' || !metricsText.length) {
      throw new Error('analyze: metricsText is required');
    }

    const token = await getAccessToken();
    if (!token) throw new Error('analyze: missing access token');

    // Build the serialized request body inline so the intermediate object and
    // the long base64 string are scoped tightly — once fetch returns, both are
    // eligible for GC and nothing in this function still references them.
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildRequestBody({ photoBuffer, metricsText, photoMimeType })),
        signal: AbortSignal.timeout(VERTEX_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`Vertex AI request failed: ${err?.message || 'unknown'}`);
    }

    if (!response.ok) {
      throw new Error(`Vertex AI returned status ${response.status}`);
    }

    // Capture diagnostic context before extracting the text so that when
    // extractContent/parseVertexOutput throws (truncated JSON, safety block,
    // shape mismatch), we can attach Vertex's own finishReason + the raw
    // content length to the error for structured logging upstream.
    const payload = await response.json();
    const candidate = payload?.candidates?.[0];
    const finishReason = candidate?.finishReason || null;
    const rawText = candidate?.content?.parts?.[0]?.text;
    const contentLength = typeof rawText === 'string' ? rawText.length : 0;
    try {
      const content = extractContent(payload);
      return parseVertexOutput(content);
    } catch (parseErr) {
      const err = new Error(parseErr.message);
      err.finishReason = finishReason;
      err.contentLength = contentLength;
      throw err;
    }
  }

  return { analyze };
}

module.exports = {
  createVertexClient,
  parseVertexOutput,
  stripCodeFences,
  stripPlusSignedIntegers,
  MAX_AI_SUMMARY_LENGTH,
  DEFAULT_MODEL,
};
