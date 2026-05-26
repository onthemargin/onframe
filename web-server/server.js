'use strict';
const express   = require('express');
const rateLimit = require('express-rate-limit');
const multer    = require('multer');
const { createVertexClient, DEFAULT_MODEL } = require('./vertex.js');

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

const MAX_PHOTO_BYTES = 6 * 1024 * 1024; // 6 MB
const MAX_METRICS_BYTES = 16 * 1024;     // 16 KB
const MAX_TOTAL_BYTES = 8 * 1024 * 1024; // 8 MB

// Defense-in-depth: zero the bytes of an in-memory photo buffer before
// dropping the reference. Setting buf = null is enough for GC, but the
// underlying memory pages may not be wiped before reuse. fill(0) guarantees
// the pixels are gone immediately.
function secureClearBuffer(buf) {
  if (Buffer.isBuffer(buf) && buf.length > 0) {
    buf.fill(0);
  }
}

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

// Phase 2: map of Vertex finding keys → { category, cap }. Sharpness is
// intentionally absent — local metrics own that category forever.
const FINDING_KEY_TO_CATEGORY = {
  lighting:    { category: 'Lighting',              cap: 10 },
  composition: { category: 'Composition & Framing', cap: 10 },
  background:  { category: 'Background',            cap: 10 },
  eyecontact:  { category: 'Eye Contact & Gaze',    cap: 10 },
  headpose:    { category: 'Head Angle & Pose',     cap:  5 },
};

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// Cards are rendered inside small mobile suggestion cards. The prompt asks
// Gemini to keep reasons ≤70 chars; this is a belt-and-suspenders cap.
const MAX_AI_REASON_LENGTH = 90;
function sanitizeAiReason(reason) {
  if (typeof reason !== 'string') return '';
  return reason.trim().slice(0, MAX_AI_REASON_LENGTH);
}

// Merge Gemini perceptual findings into the local synthesizer's cards.
// - Per-category delta caps applied before adding to local score.
// - Final per-card score clamped to [0, 100] and rounded.
// - aiReason attached only when the card was actually adjusted (delta != 0
//   after clamping) and the reason text survives sanitization.
// - Sharpness & Focus is never adjusted; unknown finding keys are ignored.
// - Returns null when localCards is missing / malformed (caller falls back
//   to aiSummary-only response).
function mergePerceptualFindings({ localCards, findings }) {
  if (!Array.isArray(localCards) || localCards.length === 0) return null;
  // Every entry must be a recognized category card.
  const sanitizedLocal = [];
  for (const card of localCards) {
    if (!card || !CATEGORY_SET.has(card.category)) return null;
    sanitizedLocal.push(sanitizeCard(card, card.category));
  }

  const findingsObj = (findings && typeof findings === 'object') ? findings : {};
  const cards = sanitizedLocal.map((card) => ({ ...card }));

  for (const [key, raw] of Object.entries(findingsObj)) {
    const mapping = FINDING_KEY_TO_CATEGORY[key];
    if (!mapping) continue;
    if (!raw || typeof raw !== 'object') continue;
    const deltaRaw = raw.delta;
    if (typeof deltaRaw !== 'number' || !Number.isFinite(deltaRaw)) continue;
    const clampedDelta = clamp(deltaRaw, -mapping.cap, mapping.cap);
    const target = cards.find((c) => c.category === mapping.category);
    if (!target) continue;
    const newScore = clamp(Math.round(target.score + clampedDelta), 0, 100);
    target.score = newScore;
    if (clampedDelta !== 0) {
      const reason = sanitizeAiReason(raw.reason);
      if (reason) target.aiReason = reason;
    }
  }

  // Recompute overall score from final merged values in canonical category order.
  const ordered = CATEGORY_CONFIG.map(({ category }) =>
    cards.find((c) => c.category === category)
  );
  if (ordered.some((c) => !c)) return null;
  return { cards: ordered, overallScore: computeOverallScore(ordered) };
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

function isAllowedImageMime(mime) {
  return mime === 'image/jpeg' || mime === 'image/webp';
}

function buildUpload() {
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_PHOTO_BYTES,
      fieldSize: MAX_METRICS_BYTES,
      fields: 4,
      files: 1,
      parts: 6,
    },
    fileFilter(_req, file, cb) {
      if (!isAllowedImageMime(file.mimetype)) {
        const err = new Error('photo must be image/jpeg or image/webp');
        err.code = 'INVALID_FILE_TYPE';
        return cb(err);
      }
      cb(null, true);
    },
  });
}

function createApp({
  vertexClient = null,
  vertexProject = process.env.VERTEX_PROJECT,
  vertexLocation = process.env.VERTEX_LOCATION || 'us-central1',
  vertexModel = process.env.VERTEX_MODEL || DEFAULT_MODEL,
  basePath = process.env.BASE_PATH || '',
  trustProxy = process.env.TRUST_PROXY,
} = {}) {
  const app  = express();
  const normalizedBasePath = normalizeBasePath(basePath);
  const apiRoot = `${normalizedBasePath}/onframe/api`;
  app.disable('x-powered-by');
  app.set('trust proxy', parseTrustProxy(trustProxy));

  let resolvedVertexClient = vertexClient;
  function getVertexClient() {
    if (resolvedVertexClient) return resolvedVertexClient;
    if (!vertexProject || !vertexLocation || !vertexModel) return null;
    try {
      resolvedVertexClient = createVertexClient({
        project: vertexProject,
        location: vertexLocation,
        model: vertexModel,
      });
    } catch (err) {
      console.error('[onframe] failed to init Vertex client:', err.message);
      resolvedVertexClient = null;
    }
    return resolvedVertexClient;
  }

  const vertexConfigured = Boolean(vertexClient || (vertexProject && vertexModel));

  app.use((req, res, next) => {
    if (req.path.startsWith(apiRoot)) {
      // no-store: no caching anywhere; private: not even intermediate proxies;
      // X-Robots-Tag: prevent any indexer that ever sees this from listing it;
      // Referrer-Policy: never leak the analyze URL when the client follows links.
      res.setHeader('Cache-Control', 'no-store, private, max-age=0');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
      res.setHeader('Referrer-Policy', 'no-referrer');
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
  const reportJson = express.json({ limit: '8kb' });

  const upload = buildUpload();

  function handleMulterError(err, req, res) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'photo exceeds 6 MB limit' });
    }
    if (err.code === 'LIMIT_FIELD_VALUE' || err.code === 'LIMIT_FIELD_SIZE') {
      return res.status(400).json({ error: 'metrics exceeds 16 KB limit' });
    }
    if (err.code === 'INVALID_FILE_TYPE') {
      return res.status(400).json({ error: err.message });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'unexpected file field' });
    }
    return res.status(400).json({ error: 'invalid multipart payload' });
  }

  const analyzeUpload = upload.single('photo');

  app.post(`${apiRoot}/analyze`, limiter, (req, res) => {
    // Short correlation id stamped on every log line for this request and
    // returned in the response so the client can render it. When a user
    // shares a screenshot, the id is the trace key into Cloud Logging.
    const requestId = require('crypto').randomUUID().slice(0, 8);
    const requestTs = new Date().toISOString();

    analyzeUpload(req, res, async (err) => {
      if (err) {
        return handleMulterError(err, req, res);
      }

      // Validate inputs (note: never log photo bytes or metrics content).
      if (!req.file || !Buffer.isBuffer(req.file.buffer) || req.file.buffer.length === 0) {
        return res.status(400).json({ error: 'photo field is required' });
      }
      if (!isAllowedImageMime(req.file.mimetype)) {
        return res.status(400).json({ error: 'photo must be image/jpeg or image/webp' });
      }
      const metricsRaw = req.body?.metrics;
      if (typeof metricsRaw !== 'string' || !metricsRaw.length) {
        return res.status(400).json({ error: 'metrics field is required' });
      }
      if (Buffer.byteLength(metricsRaw, 'utf8') > MAX_METRICS_BYTES) {
        return res.status(400).json({ error: 'metrics exceeds 16 KB limit' });
      }
      try {
        JSON.parse(metricsRaw);
      } catch {
        return res.status(400).json({ error: 'metrics must be valid JSON' });
      }

      const totalBytes = req.file.buffer.length + Buffer.byteLength(metricsRaw, 'utf8');
      if (totalBytes > MAX_TOTAL_BYTES) {
        return res.status(400).json({ error: 'request payload too large' });
      }

      console.log(`[onframe] analyze request id=${requestId} ts=${requestTs} bytes=${req.file.buffer.length}`);

      const client = getVertexClient();
      if (!client) {
        console.log(`[onframe] analyze unavailable id=${requestId} reason=no-client`);
        return res.json({ id: requestId, ts: requestTs, aiUnavailable: true });
      }

      try {
        const result = await client.analyze({
          photoBuffer: req.file.buffer,
          metricsText: metricsRaw,
          photoMimeType: req.file.mimetype,
        });
        if (!result || typeof result.aiSummary !== 'string' || !result.aiSummary.length) {
          console.log(`[onframe] analyze unavailable id=${requestId} reason=empty-summary`);
          return res.json({ id: requestId, ts: requestTs, aiUnavailable: true });
        }
        const aiSummary = result.aiSummary.slice(0, 500);

        // Phase 2: if vertex returned perceptualFindings AND the client passed
        // localCards in metrics, merge bounded deltas server-side and return
        // the cards + recomputed overall score. Otherwise return aiSummary only.
        const findings = result.perceptualFindings;
        const hasFindings = findings && typeof findings === 'object' && Object.keys(findings).length > 0;
        let metricsParsed = null;
        try { metricsParsed = JSON.parse(metricsRaw); } catch { /* validated earlier */ }
        const localCards = metricsParsed?.localCards;
        if (hasFindings && Array.isArray(localCards) && localCards.length > 0) {
          const merged = mergePerceptualFindings({ localCards, findings });
          if (merged) {
            console.log(`[onframe] analyze OK id=${requestId} merged=true overallScore=${merged.overallScore}`);
            return res.json({ id: requestId, ts: requestTs, aiSummary, cards: merged.cards, overallScore: merged.overallScore });
          }
        }

        console.log(`[onframe] analyze OK id=${requestId} merged=false`);
        return res.json({ id: requestId, ts: requestTs, aiSummary });
      } catch (vertexErr) {
        // Structured warning so we can observe the parse-failure rate over
        // time without ever logging photo bytes or response content.
        const errMsg = vertexErr?.message || 'unknown';
        console.error(JSON.stringify({
          severity: 'WARNING',
          type: 'onframe_vertex_error',
          id: requestId,
          ts: requestTs,
          kind: /not valid JSON|missing aiSummary|empty content|missing candidates|missing content parts|missing text content|exceeds maximum length/i.test(errMsg)
            ? 'parse_or_shape'
            : /timeout|abort|failed/i.test(errMsg)
              ? 'transport'
              : 'other',
          message: errMsg.slice(0, 200),
          // Vertex's own finishReason (STOP / MAX_TOKENS / SAFETY / RECITATION
          // / OTHER) + the byte length of what the model managed to emit.
          // Lets us tell "Gemini hit the token cap" apart from "safety
          // filter cut us off" apart from "model produced garbage."
          finishReason: vertexErr?.finishReason ?? null,
          contentLength: vertexErr?.contentLength ?? null,
        }));
        return res.json({ id: requestId, ts: requestTs, aiUnavailable: true });
      } finally {
        // Zero-fill the photo bytes before dropping the reference so memory
        // pages don't retain readable pixel data until GC + page reuse.
        if (req.file) {
          secureClearBuffer(req.file.buffer);
          req.file.buffer = null;
        }
      }
    });
  });

  app.post(`${apiRoot}/report`, reportLimiter, reportJson, (req, res) => {
    const { id, ts, userText, overallScore, photoType, cardScores, error, context, fileInfo, device } = req.body || {};
    const safeContext = context === 'error' ? 'error' : 'results';
    const severity = safeContext === 'error' ? 'WARNING' : 'INFO';
    // Whitelist-only logging: photo and metrics keys are never reflected.
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
      device,
    }));
    res.json({ ok: true, id: String(id || '').slice(0, 64) });
  });

  app.get(`${apiRoot}/health`, (_req, res) => {
    res.json({ ok: true, vertexConfigured });
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
  createApp,
  computeOverallScore,
  mergePerceptualFindings,
  normalizeAiResponse,
  normalizeBasePath,
  normalizeSummary,
  parseTrustProxy,
  sanitizeCard,
  sanitizeGearNeeded,
  secureClearBuffer,
  startServer,
};
