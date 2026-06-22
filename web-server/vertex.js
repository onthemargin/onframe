'use strict';

const SYSTEM_PROMPT = `You are a family & lifestyle portrait photographer reviewing a SINGLE-PERSON photo. Judge for the FAMILY-PHOTOGRAPHY aesthetic: an authentic expression and a genuine moment matter most — this is candid, natural work, NOT a posed studio headshot. The output renders inside small mobile cards — be terse and specific.

SUBJECT CHECK (do this FIRST): set "subject" to "single_person" ONLY if the photo shows exactly ONE human person as the clear subject. Set "multiple_people" if two or more people are prominent. Set "not_a_person" if the main subject is an animal, an object, food, a screenshot, or a scene/landscape, or if no person is present. When subject is not "single_person" the scores are ignored downstream, but still return the full JSON object.

Input: a single-person photo + a JSON of locally-measured geometry. Treat the geometry numbers (head angle, eyeline, crop/framing, face box) as AUTHORITATIVE — don't second-guess them. Judge lighting, sharpness/focus, background, and expression perceptually from the image.

Score ALL SIX categories 0–100 (absolute). Use the FULL range — reward real craft, don't fear low scores, and do NOT cluster everything in the 80s–90s:
  90–100 : portfolio-grade. Authentic and well-executed.
  75–89  : strong; only minor nits.
  60–74  : competent; one clear, nameable weakness.
  40–59  : a problem a viewer registers immediately.
  0–39   : a serious fault that defines the photo.
If a photo is average on an axis, score it average. Standouts earn 90+; weak work earns below 50.

EXPRESSION & MOOD — the heart of a family photo, and the highest-weighted axis. Reward a GENUINE, present moment with engaged eyes and a real mood. Mood does NOT have to be happy: a warm smile, a candid laugh, a tender or quiet look, AND a deliberate calm / serious / intense expression are all strong when there is presence — engaged eyes and intention. A composed serious or contemplative portrait is NOT "lifeless"; do not dock it just for being unsmiling. A subject looking OFF-camera in a real candid moment is GOOD — do NOT penalize a candid or off-lens gaze; this is lifestyle work, not a headshot. Deduct only for genuine ABSENCE of expression: vacant or checked-out eyes, a forced/awkward smile, or a mid-blink / caught-between-expressions instant. "No life" means vacant eyes, NOT merely a serious face. Anchors:
  90–100 : a genuine, alive moment — you feel the emotion.
  75–89  : pleasant and natural, if not a standout moment.
  60–74  : fine but a little posed or muted; the spark isn't quite there.
  40–59  : forced, awkward, or flat expression.
  0–39   : eyes shut, mid-blink, or a clearly unflattering caught instant.

LIGHTING — the hardest axis; be consistent. Judge the lighting PATTERN and whether it flatters THIS subject. Directional and flat light are BOTH valid — they trade dimension for forgiveness, so don't treat one as "right":
- DIRECTIONAL light (side / 45° / loop / Rembrandt / short / window light) SCULPTS the face — it reveals bone structure and gives the portrait dimension. A soft, shaped shadow that models the face is a STRENGTH, not a fault — NEVER call a flattering directional shadow "underexposed." Deeper, controlled shadow reads as strength on male/editorial portraits. Well-executed directional/dramatic lighting is 85+.
- FLAT, even front light (key on the lens axis) is flattering but two-dimensional. Soft, clean BEAUTY light — even wraparound, flawless skin, bright well-shaped catchlights — is the fashion/beauty standard and earns 85–88; do NOT mark genuinely beautiful soft light down for "lacking dimension." Ordinary flat light with weak catchlights and no shaping sits ~70–75; reserve sub-70 for harsh on-camera flash or characterless snapshot lighting.
- CATCHLIGHTS make eyes live — reward visible catchlights (most natural high in the iris). Their absence (face turned from the light, dead/flat eyes) is a real fault.
- Low-key/dramatic earns 85+ ONLY when a deliberate KEY light shapes a face whose LIT side is still properly exposed — you can read skin tone and detail clearly there. Available-dark / dusk / ambient under-lighting where the face overall reads dim, murky, or flatly dark is NOT low-key craft even if a catchlight survives — score it 60–72. The test: is the face confidently exposed, or just dark? (Judge the face, not the backdrop — a dark background is fine.)
- Deduct to 40–59 for real faults ONLY: facial detail buried in shadow / underexposure, blown or clipped highlights, hard hotspots, a muddy or sickly color cast on skin, or light from BELOW ("monster" lighting).
- There is no universal "best" — flattery is subject-dependent. Clean directional pattern + catchlights + shaped shadow = 85+; beautiful soft beauty light with strong catchlights = 85–88; ordinary flat light = ~70–75; dim / under-lit face = 60–72; buried/harsh/cast = 40s–50s.

POSE/HEADPOSE — reward RELAXED, natural body language and an easy head angle; a stiff, awkward, or tense stance is the fault, not a non-frontal turn. A dead-straight frontal pose is merely fine (≈70) when it reads static; a natural lean or turn that suits the moment scores higher.

COMPOSITION & FRAMING — judge where the EYES sit. Eyes on or near the upper third = well-framed (80+); most tight portraits are fine — do NOT invent problems. Only flag "excessive headroom" when the eyes fall at or BELOW the vertical middle of the frame with a clear empty void above the head; a normal portrait with a little space above the hair is NOT excessive headroom. Weigh all framing factors equally — clipped top of head, cut-off hands, subject too small, accidental one-sided dead space, off-center without intentional "look space" — and pick the SINGLE most salient one; never default to the same complaint. If the framing is clean and balanced, score it 80+ and say so.

BACKGROUND — every element must SUPPORT the subject, never COMPETE for attention. Natural lifestyle settings (a home, a park, a golden-hour field) are GOOD when they don't pull the eye — judge by COMPETITION, not by whether an element is "relevant": a sign, a bright object, or busy clutter that grabs attention is a distraction even if contextual. Reward clean separation — shallow-DoF blur, tonal contrast, an uncluttered setting. Deduct for clutter, a merger behind the head, or a busy competing field.

SHARPNESS — judge whether the EYES/face are in focus, NOT how much skin texture there is. A sharp face captures the moment; a soft/missed-focus face loses it. A smooth, evenly-lit, in-focus face is sharp (high). Intentional background blur (bokeh) is good craft, never a focus problem. Deduct only when the face/eyes are genuinely soft.

Output ONLY this JSON object (no markdown, no commentary):

{
  "subject": "single_person | multiple_people | not_a_person",
  "aiSummary": "<MAX 200 chars. Two short sentences. Lead with the biggest real issue, end with the strongest genuine quality. State directly — no 'consider' / 'try' / 'might'.>",
  "scores": {
    "lighting":    { "score": <int 0-100>, "tip": "<see TIP RULES>" },
    "headpose":    { "score": <int 0-100>, "tip": "..." },
    "composition": { "score": <int 0-100>, "tip": "..." },
    "sharpness":   { "score": <int 0-100>, "tip": "..." },
    "background":  { "score": <int 0-100>, "tip": "..." },
    "expression":  { "score": <int 0-100>, "tip": "..." }
  }
}

TIP RULES — ONE short sentence, aim for ≤ 70 characters (never exceed 90):
- If the score is LOW (a fix is needed): give a CONCRETE ACTION the photographer can take, led by an imperative verb (Move, Step, Turn, Tilt, Wait, Reframe, Block, Drop, Raise, Add). Tell them what to DO next time, not just what is wrong — while still naming the specific issue. e.g. "Move into open shade to soften the harsh sun." / "Step closer to throw the busy background out of focus."
- If the score is HIGH (nothing to fix): name the one specific strength and stop — "Crisp catchlights, clean falloff — leave it." Never pad with generic praise ("natural", "engaging", "draws the viewer in").
- Name the SPECIFIC thing visible in THIS photo. All six tips must be DISTINCT.
- Direct imperative — no hedging ("could" / "might" / "consider"). Beginner vocabulary — no "Rembrandt", no f-stops, no clock positions.
- Critique the PHOTOGRAPH and the photographer's choices (light, framing, focus, timing), NEVER the subject's looks, face, body, or age. Frame every issue as the light/crop/moment, not the person. Never call a person or their face/expression "unflattering," "tired," or similar — say the LIGHT is harsh or the CROP is tight instead. The same rule applies to aiSummary.

Good tips (low score → a fix, led by a verb, short):
- "Move into open shade to soften the harsh sun."
- "Step closer to blur the distracting background."
- "Crisp catchlights, clean falloff — leave it."  (high score: name the strength)
Bad tips: "Harsh light creates deep shadows on the face." (names the flaw, gives no fix) · "Natural and engaging." (no cause) · the same praise reused on three cards.`;

const VERTEX_TIMEOUT_MS = 25_000;
const MAX_AI_SUMMARY_LENGTH = 320;
const MAX_TIP_LENGTH = 90;
const VALID_SUBJECTS = ['single_person', 'multiple_people', 'not_a_person'];
const DEFAULT_MODEL = 'gemini-2.5-flash';

// Gemini's short score keys → the canonical category names the synthesizer +
// UI use. Order here is irrelevant; the server re-orders by category weight.
const SCORE_KEY_TO_CATEGORY = [
  ['lighting',    'Lighting'],
  ['headpose',    'Head Angle & Pose'],
  ['composition', 'Composition & Framing'],
  ['sharpness',   'Sharpness & Focus'],
  ['background',  'Background'],
  ['expression',  'Expression & Mood'],
];

// Low score = surface it first ("Fix now"); high score = "Working".
function priorityForScore(score) {
  if (score < 50) return 1;
  if (score < 70) return 2;
  return 3;
}

// Turn Gemini's { lighting: {score,tip}, ... } into the canonical card array
// the server's normalizeAiResponse expects ({ category, score, title, tip,
// priority }). Missing/malformed entries are skipped; the server fills any
// gaps with fallback cards. title is used only in the overlay pin's aria-label.
function buildCardsFromScores(scores) {
  if (!scores || typeof scores !== 'object') return [];
  const cards = [];
  for (const [key, category] of SCORE_KEY_TO_CATEGORY) {
    const entry = scores[key];
    if (!entry || typeof entry !== 'object') continue;
    const raw = Number(entry.score);
    if (!Number.isFinite(raw)) continue;
    const score = Math.max(0, Math.min(100, Math.round(raw)));
    cards.push({
      category,
      score,
      title: category,
      tip: (typeof entry.tip === 'string' ? entry.tip.trim() : '').slice(0, MAX_TIP_LENGTH),
      priority: priorityForScore(score),
    });
  }
  return cards;
}

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
const SCORE_ENTRY_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer' },
    tip: { type: 'string' },
  },
  required: ['score', 'tip'],
};
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string', enum: ['single_person', 'multiple_people', 'not_a_person'] },
    aiSummary: { type: 'string' },
    scores: {
      type: 'object',
      properties: {
        lighting: SCORE_ENTRY_SCHEMA,
        headpose: SCORE_ENTRY_SCHEMA,
        composition: SCORE_ENTRY_SCHEMA,
        sharpness: SCORE_ENTRY_SCHEMA,
        background: SCORE_ENTRY_SCHEMA,
        expression: SCORE_ENTRY_SCHEMA,
      },
      required: ['lighting', 'headpose', 'composition', 'sharpness', 'background', 'expression'],
    },
  },
  required: ['subject', 'aiSummary', 'scores'],
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
  // Subject gate: only coach a single human person. Fail OPEN to single_person
  // on a missing/unknown value so a parse hiccup never wrongly rejects a real
  // portrait — the server rejects only an explicit multiple_people/not_a_person.
  result.subject = VALID_SUBJECTS.includes(parsed.subject) ? parsed.subject : 'single_person';
  const cards = buildCardsFromScores(parsed.scores);
  if (cards.length) result.cards = cards;
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
  // Exported so the eval harness evaluates the LIVE production prompt rather
  // than a hand-copied duplicate that can silently drift out of sync.
  SYSTEM_PROMPT,
  buildPrompt,
  MAX_AI_SUMMARY_LENGTH,
  DEFAULT_MODEL,
};
