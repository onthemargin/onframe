'use strict';
const express   = require('express');
const rateLimit = require('express-rate-limit');

const PORT = process.env.PORT || 3004;
const HOST = process.env.HOST || '127.0.0.1';
const CATEGORY_CONFIG = [
  { category: 'Lighting', weight: 0.30 },
  { category: 'Head Angle & Pose', weight: 0.25 },
  { category: 'Composition & Framing', weight: 0.20 },
  { category: 'Sharpness & Focus', weight: 0.15 },
  { category: 'Background', weight: 0.05 },
  { category: 'Eye Contact & Gaze', weight: 0.05 },
];
const CATEGORY_SET = new Set(CATEGORY_CONFIG.map(({ category }) => category));

const SYSTEM_PROMPT = `You are a professional portrait photography coach with deep expertise in lighting, composition, head pose, and expression science.

You will receive a structured text summary of measured vision metrics for a portrait photo. Analyze these metrics and return a JSON object with the following exact structure:

{
  "overallScore": <number 0-100>,
  "aiSummary": "<2-3 sentence plain-English assessment of the portrait's main strengths and most important improvement>",
  "cards": [
    {
      "category": "<one of: Lighting, Head Angle & Pose, Composition & Framing, Sharpness & Focus, Background, Eye Contact & Gaze>",
      "score": <number 0-100>,
      "title": "<6–10 word coaching headline>",
      "tip": "<2–4 sentences of actionable coaching using photography craft vocabulary: lighting patterns, catchlights, the squinch, Duchenne smile, depth of field, etc.>",
      "priority": <1=critical, 2=important, 3=minor>,
      "requiresGear": <true if fix needs equipment beyond a phone, false otherwise>
    }
  ]
}

Rules:
- Return exactly 6 cards, one per category.
- Scores must be consistent with overallScore (weighted: Lighting 0.30, Head Angle 0.25, Composition 0.20, Sharpness 0.15, Background 0.05, Eye Contact 0.05).
- Use specific photography vocabulary: "catchlight at 10 o'clock", "loop lighting", "squinch", "Duchenne smile", "short vs broad lighting", "Rembrandt triangle", etc.
- For each finding, tell the photographer WHAT the issue is, WHY it matters, and HOW to fix it.
- Keep tip text actionable and photographer-directed (e.g., "Move your key light 30° to the left" not "The lighting could be improved").
- Return ONLY valid JSON. No markdown, no code fences, no explanation outside the JSON object.`;

function normalizeSummary(summary) {
  if (typeof summary !== 'string') return null;
  const normalized = summary.replace(/\s+/g, ' ').trim();
  return normalized || null;
}

function sanitizeGearNeeded(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => String(item || '').trim().slice(0, 50))
    .filter(Boolean)
    .filter(item => item.toLowerCase() !== 'gear');
}

function sanitizeCard(card, fallbackCategory = CATEGORY_CONFIG[0].category) {
  const category = CATEGORY_SET.has(card?.category) ? card.category : fallbackCategory;
  const gearNeeded = sanitizeGearNeeded(card?.gearNeeded);
  const requiresGear = Boolean(card?.requiresGear);
  return {
    category,
    score: Math.max(0, Math.min(100, Math.round(Number(card?.score) || 0))),
    title: String(card?.title || '').trim().slice(0, 200),
    tip: String(card?.tip || '').trim().slice(0, 1000),
    priority: Math.max(1, Math.min(3, Number(card?.priority) || 3)),
    gearNeeded: requiresGear && gearNeeded.length === 0 ? ['tripod'] : gearNeeded,
  };
}

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  err.publicMessage = message;
  return err;
}

function buildFallbackCard(category) {
  return {
    category,
    score: 0,
    title: `${category} needs review`,
    tip: 'AI coaching for this category was incomplete. Re-run the analysis to get a full set of coaching cards.',
    priority: 1,
    gearNeeded: [],
  };
}

function buildFallbackSummary(cards) {
  const sorted = [...cards].sort((a, b) => a.score - b.score);
  const weakest = sorted[0]?.category || 'portrait fundamentals';
  const strongest = sorted[sorted.length - 1]?.category || 'portrait fundamentals';
  return `Strongest area: ${strongest}. Biggest opportunity: ${weakest}.`;
}

function normalizeCards(cards) {
  const input = Array.isArray(cards) ? cards : [];
  const byCategory = new Map();

  for (const rawCard of input) {
    if (!CATEGORY_SET.has(rawCard?.category) || byCategory.has(rawCard.category)) {
      continue;
    }
    byCategory.set(rawCard.category, sanitizeCard(rawCard, rawCard.category));
  }

  return CATEGORY_CONFIG.map(({ category }) =>
    byCategory.get(category) || buildFallbackCard(category)
  );
}

function computeOverallScore(cards) {
  return Math.round(
    CATEGORY_CONFIG.reduce((sum, { weight }, index) => sum + cards[index].score * weight, 0)
  );
}

function normalizeAiResponse(parsed) {
  const cards = normalizeCards(parsed?.cards);
  const aiSummary = normalizeSummary(parsed?.aiSummary) || buildFallbackSummary(cards);

  return {
    overallScore: computeOverallScore(cards),
    aiSummary: aiSummary.slice(0, 500),
    cards,
  };
}

function normalizeBasePath(basePath) {
  const normalized = String(basePath || '').trim();
  if (!normalized || normalized === '/') return '';
  return `/${normalized.replace(/^\/+|\/+$/g, '')}`;
}

function parseTrustProxy(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  if (/^\d+$/.test(normalized)) return Number(normalized);
  return normalized;
}

async function analyzeSummary({
  summary,
  groqApiKey,
  aiModel = process.env.AI_MODEL || 'llama-3.3-70b-versatile',
  fetchImpl = global.fetch,
} = {}) {
  const normalizedSummary = normalizeSummary(summary);
  if (!normalizedSummary || normalizedSummary.length < 10 || normalizedSummary.length > 5000) {
    throw fail(400, 'summary must be a string between 10 and 5000 characters');
  }

  if (!groqApiKey) {
    throw fail(503, 'Cloud mode unavailable — GROQ_API_KEY not configured');
  }

  let groqRes;
  try {
    groqRes = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: aiModel,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: normalizedSummary },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 1200,
      }),
      signal: AbortSignal.timeout(25_000),
    });
  } catch (err) {
    console.error('[onframe] Groq fetch error:', err.message);
    const isTimeout = err?.name === 'TimeoutError'
      || err?.name === 'AbortError'
      || /timeout/i.test(String(err?.message || ''));
    throw fail(503, isTimeout
      ? 'AI service timeout — try again in a moment'
      : 'AI service unavailable — try again in a moment');
  }

  if (!groqRes.ok) {
    console.error(`[onframe] AI service error: ${groqRes.status}`);
    if (groqRes.status === 429) {
      throw fail(503, 'AI service rate limited — try again shortly');
    }
    throw fail(503, 'AI service unavailable');
  }

  let parsed;
  try {
    const raw = await groqRes.json();
    const content = raw.choices?.[0]?.message?.content;
    if (!content) throw new Error('empty response');
    parsed = JSON.parse(content);
  } catch (err) {
    console.error('[onframe] parse error:', err.message);
    throw fail(500, 'Failed to parse AI response');
  }

  if (!Array.isArray(parsed.cards) || typeof parsed.overallScore !== 'number') {
    throw fail(500, 'AI response missing required fields');
  }

  return normalizeAiResponse(parsed);
}

function createApp({
  groqApiKey = process.env.GROQ_API_KEY,
  aiModel = process.env.AI_MODEL || 'llama-3.3-70b-versatile',
  basePath = process.env.BASE_PATH || '',
  trustProxy = process.env.TRUST_PROXY,
  fetchImpl = global.fetch,
} = {}) {
  const app  = express();
  const normalizedBasePath = normalizeBasePath(basePath);
  const apiRoot = `${normalizedBasePath}/onframe/api`;
  app.disable('x-powered-by');
  app.set('trust proxy', parseTrustProxy(trustProxy));

  app.use((req, res, next) => {
    if (req.path.startsWith(apiRoot)) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
    next();
  });

  const limiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests — please wait a minute.' },
  });
  const reportLimiter = rateLimit({
    windowMs: 60_000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many reports — please wait a minute.' },
  });
  const analyzeJson = express.json({ limit: '16kb' });
  const reportJson = express.json({ limit: '8kb' });

  app.post(`${apiRoot}/analyze`, limiter, analyzeJson, async (req, res) => {
    console.log(`[onframe] analyze request — ${new Date().toISOString()}`);
    try {
      const safeResponse = await analyzeSummary({
        summary: req.body?.summary,
        groqApiKey,
        aiModel,
        fetchImpl,
      });
      console.log(`[onframe] analyze OK — score ${safeResponse.overallScore}`);
      return res.json(safeResponse);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.publicMessage || 'Internal server error' });
    }
  });

  app.post(`${apiRoot}/report`, reportLimiter, reportJson, (req, res) => {
    const { id, ts, userText, overallScore, photoType, cardScores, error, context, fileInfo, device } = req.body || {};
    const safeContext = context === 'error' ? 'error' : 'results';
    const severity = safeContext === 'error' ? 'WARNING' : 'INFO';
    console.log(JSON.stringify({
      severity,
      type: 'onframe_report',
      id: String(id || '').slice(0, 64),
      ts: normalizeSummary(ts) || new Date().toISOString(),
      context: safeContext,
      userText: String(userText || '').slice(0, 500),
      error,
      fileInfo,
      overallScore: Math.max(0, Math.min(100, Number(overallScore) || 0)),
      photoType,
      cardScores: Array.isArray(cardScores) ? cardScores.slice(0, CATEGORY_CONFIG.length) : [],
      metrics: req.body?.metrics && typeof req.body.metrics === 'object' ? req.body.metrics : null,
      device,
    }));
    res.json({ ok: true, id: String(id || '').slice(0, 64) });
  });

  app.get(`${apiRoot}/health`, (_req, res) => {
    res.json({ ok: true, aiModelConfigured: Boolean(groqApiKey) });
  });

  app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err && req.path.startsWith(apiRoot)) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
    return next(err);
  });

  return app;
}

function startServer() {
  const app = createApp();
  return app.listen(PORT, HOST, () =>
    console.log(`onframe-web server listening on ${HOST}:${PORT}`)
  );
}

if (require.main === module) {
  startServer();
}

module.exports = {
  analyzeSummary,
  createApp,
  computeOverallScore,
  normalizeAiResponse,
  normalizeBasePath,
  normalizeSummary,
  parseTrustProxy,
  sanitizeCard,
  sanitizeGearNeeded,
  startServer,
};
