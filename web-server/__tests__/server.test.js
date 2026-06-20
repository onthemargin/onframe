import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import serverModule from '../server.js';

const {
  computeOverallScore,
  createApp,
  mergePerceptualFindings,
  normalizeAiResponse,
  normalizeBasePath,
  normalizeSummary,
  parseTrustProxy,
  sanitizeCard,
  sanitizeGearNeeded,
  secureClearBuffer,
  sniffImageMime,
  sanitizeReportDevice,
  sanitizeReportFileInfo,
} = serverModule;

// Minimal valid magic-byte headers for sniff tests.
const TINY_WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]), // little-endian file size (ignored by sniff)
  Buffer.from('WEBP'),
  Buffer.from('VP8 '),
]);
const NOT_AN_IMAGE = Buffer.from('this is plainly not an image payload at all');

function makeLocalCards(overrides = {}) {
  const base = [
    { category: 'Lighting',              score: 70, title: 'Light',   tip: 'Tip', priority: 2, gearNeeded: [] },
    { category: 'Head Angle & Pose',     score: 75, title: 'Pose',    tip: 'Tip', priority: 2, gearNeeded: [] },
    { category: 'Composition & Framing', score: 80, title: 'Frame',   tip: 'Tip', priority: 2, gearNeeded: [] },
    { category: 'Sharpness & Focus',     score: 65, title: 'Sharp',   tip: 'Tip', priority: 2, gearNeeded: [] },
    { category: 'Background',            score: 60, title: 'Bg',      tip: 'Tip', priority: 2, gearNeeded: [] },
    { category: 'Eye Contact & Gaze',    score: 72, title: 'Eyes',    tip: 'Tip', priority: 2, gearNeeded: [] },
  ];
  return base.map((card) => {
    const override = overrides[card.category];
    return override ? { ...card, ...override } : card;
  });
}

// A tiny valid-looking JPEG header is enough; multer is content-type driven.
const TINY_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);
const VALID_METRICS = JSON.stringify({
  summary: 'Portrait with even lighting.',
  photoType: 'head-and-shoulders',
  localScores: { lighting: 70 },
});

const VALID_LOCAL_CARDS = [
  { category: 'Lighting',              score: 70, title: 'Light',   tip: 'Tip', priority: 2, gearNeeded: [] },
  { category: 'Head Angle & Pose',     score: 75, title: 'Pose',    tip: 'Tip', priority: 2, gearNeeded: [] },
  { category: 'Composition & Framing', score: 80, title: 'Frame',   tip: 'Tip', priority: 2, gearNeeded: [] },
  { category: 'Sharpness & Focus',     score: 65, title: 'Sharp',   tip: 'Tip', priority: 2, gearNeeded: [] },
  { category: 'Background',            score: 60, title: 'Bg',      tip: 'Tip', priority: 2, gearNeeded: [] },
  { category: 'Eye Contact & Gaze',    score: 72, title: 'Eyes',    tip: 'Tip', priority: 2, gearNeeded: [] },
];

const VALID_METRICS_WITH_CARDS = JSON.stringify({
  summary: 'Portrait with even lighting.',
  photoType: 'head-and-shoulders',
  localScores: { lighting: 70 },
  localCards: VALID_LOCAL_CARDS,
});

function stubVertexSuccess(aiSummary = 'Looks nice and natural.') {
  return { analyze: vi.fn().mockResolvedValue({ aiSummary }) };
}

function stubVertexFailure(error = new Error('vertex down')) {
  return { analyze: vi.fn().mockRejectedValue(error) };
}

const ANALYZE_PATH = '/onframe/api/analyze';
const REPORT_PATH = '/onframe/api/report';
const HEALTH_PATH = '/onframe/api/health';

describe('secureClearBuffer', () => {
  it('zeroes every byte of the buffer in place', () => {
    const buf = Buffer.from([0xff, 0x42, 0x10, 0xab]);
    secureClearBuffer(buf);
    expect(Array.from(buf)).toEqual([0, 0, 0, 0]);
  });

  it('no-ops on null / undefined / non-buffer inputs', () => {
    expect(() => secureClearBuffer(null)).not.toThrow();
    expect(() => secureClearBuffer(undefined)).not.toThrow();
    expect(() => secureClearBuffer('a string')).not.toThrow();
    expect(() => secureClearBuffer({})).not.toThrow();
  });
});

describe('normalizeSummary', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeSummary('  hello  ')).toBe('hello');
  });

  it('returns null for non-strings', () => {
    expect(normalizeSummary(123)).toBeNull();
  });
});

describe('sanitizeGearNeeded', () => {
  it('keeps only specific non-empty gear labels', () => {
    expect(sanitizeGearNeeded([' reflector ', '', 'gear', 'softbox'])).toEqual(['reflector', 'softbox']);
  });

  it('returns empty array for non-arrays', () => {
    expect(sanitizeGearNeeded(true)).toEqual([]);
  });
});

describe('sanitizeCard', () => {
  it('clamps and sanitizes card fields', () => {
    const card = sanitizeCard({
      category: 'Lighting',
      score: 150,
      title: 'A'.repeat(250),
      tip: 'B'.repeat(1200),
      priority: 99,
      gearNeeded: [' reflector ', 'gear'],
    });
    expect(card.score).toBe(100);
    expect(card.priority).toBe(3);
    expect(card.title).toHaveLength(200);
    expect(card.tip).toHaveLength(1000);
    expect(card.gearNeeded).toEqual(['reflector']);
  });

  it('uses fallback category and requiresGear fallback', () => {
    const card = sanitizeCard({
      category: 'Unknown',
      score: 75.8,
      requiresGear: true,
    }, 'Background');
    expect(card.category).toBe('Background');
    expect(card.score).toBe(76);
    expect(card.gearNeeded).toEqual(['tripod']);
  });
});

describe('normalizeAiResponse', () => {
  it('returns cards in canonical order and fills missing categories', () => {
    const normalized = normalizeAiResponse({
      aiSummary: '  Strong lighting.  ',
      overallScore: 99,
      cards: [
        { category: 'Background', score: 70, title: 'Bg', tip: 'Tip', priority: 2 },
        { category: 'Lighting', score: 80, title: 'Light', tip: 'Tip', priority: 2 },
        { category: 'Lighting', score: 20, title: 'Duplicate', tip: 'Tip', priority: 1 },
      ],
    });

    expect(normalized.cards).toHaveLength(6);
    expect(normalized.cards.map((card) => card.category)).toEqual([
      'Lighting',
      'Head Angle & Pose',
      'Composition & Framing',
      'Sharpness & Focus',
      'Background',
      'Eye Contact & Gaze',
    ]);
    expect(normalized.cards[0].score).toBe(80);
    expect(normalized.cards[1].score).toBe(0);
    expect(normalized.aiSummary).toBe('Strong lighting.');
    expect(normalized.overallScore).toBe(computeOverallScore(normalized.cards));
  });
});

describe('normalizeBasePath', () => {
  it('normalizes empty and slash-wrapped base paths', () => {
    expect(normalizeBasePath('')).toBe('');
    expect(normalizeBasePath('/')).toBe('');
    expect(normalizeBasePath('/prod/app/')).toBe('/prod/app');
  });
});

describe('parseTrustProxy', () => {
  it('parses booleans and hop counts', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('loopback')).toBe('loopback');
  });
});

describe('createApp', () => {
  it('returns an express application function', () => {
    const app = createApp({ vertexClient: stubVertexSuccess() });
    expect(typeof app).toBe('function');
    expect(typeof app.use).toBe('function');
    expect(typeof app.post).toBe('function');
  });

  it('applies trust proxy parsing to express settings', () => {
    const app = createApp({ vertexClient: stubVertexSuccess(), trustProxy: '2' });
    expect(app.get('trust proxy')).toBe(2);
  });

  it('registers analyze, report, and health routes under the normalized base path', () => {
    const app = createApp({ vertexClient: stubVertexSuccess(), basePath: '/prod/' });
    const routes = app._router.stack
      .filter((layer) => layer.route)
      .map((layer) => layer.route.path);

    expect(routes).toContain('/prod/onframe/api/health');
    expect(routes).toContain('/prod/onframe/api/analyze');
    expect(routes).toContain('/prod/onframe/api/report');
  });
});

describe('POST /onframe/api/analyze', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns 400 when photo is missing', async () => {
    const app = createApp({
      vertexClient: stubVertexSuccess(),
      vertexModel: 'endpoint-id',
      vertexProject: 'p',
      vertexLocation: 'us-central1',
    });
    const res = await request(app).post(ANALYZE_PATH).field('metrics', VALID_METRICS);
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('returns 400 when metrics is missing', async () => {
    const app = createApp({
      vertexClient: stubVertexSuccess(),
      vertexModel: 'endpoint-id',
      vertexProject: 'p',
      vertexLocation: 'us-central1',
    });
    const res = await request(app)
      .post(ANALYZE_PATH)
      .attach('photo', TINY_JPEG, { filename: 'p.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('returns 400 when metrics is not valid JSON', async () => {
    const app = createApp({
      vertexClient: stubVertexSuccess(),
      vertexModel: 'endpoint-id',
      vertexProject: 'p',
      vertexLocation: 'us-central1',
    });
    const res = await request(app)
      .post(ANALYZE_PATH)
      .field('metrics', 'not json at all')
      .attach('photo', TINY_JPEG, { filename: 'p.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('returns 400 when photo content type is not an image', async () => {
    const app = createApp({
      vertexClient: stubVertexSuccess(),
      vertexModel: 'endpoint-id',
      vertexProject: 'p',
      vertexLocation: 'us-central1',
    });
    const res = await request(app)
      .post(ANALYZE_PATH)
      .field('metrics', VALID_METRICS)
      .attach('photo', Buffer.from('hello'), { filename: 'p.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('returns 400 when photo exceeds 6 MB', async () => {
    const app = createApp({
      vertexClient: stubVertexSuccess(),
      vertexModel: 'endpoint-id',
      vertexProject: 'p',
      vertexLocation: 'us-central1',
    });
    const bigPhoto = Buffer.alloc(6 * 1024 * 1024 + 1024, 0xff);
    const res = await request(app)
      .post(ANALYZE_PATH)
      .field('metrics', VALID_METRICS)
      .attach('photo', bigPhoto, { filename: 'p.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('returns 400 when metrics exceeds 16 KB', async () => {
    const app = createApp({
      vertexClient: stubVertexSuccess(),
      vertexModel: 'endpoint-id',
      vertexProject: 'p',
      vertexLocation: 'us-central1',
    });
    const bigMetrics = JSON.stringify({ summary: 'x'.repeat(20 * 1024) });
    const res = await request(app)
      .post(ANALYZE_PATH)
      .field('metrics', bigMetrics)
      .attach('photo', TINY_JPEG, { filename: 'p.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('sets strict no-cache/no-index headers on the analyze response', async () => {
    const app = createApp({
      vertexClient: stubVertexSuccess(),
      vertexModel: 'gemini-2.5-flash',
      vertexProject: 'p',
      vertexLocation: 'us-central1',
    });
    const res = await request(app)
      .post(ANALYZE_PATH)
      .field('metrics', VALID_METRICS)
      .attach('photo', TINY_JPEG, { filename: 'p.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.headers['cache-control']).toMatch(/private/);
    expect(res.headers['x-robots-tag']).toMatch(/noindex/);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('returns aiSummary when vertex succeeds', async () => {
    const vertexClient = stubVertexSuccess('Friendly summary.');
    const app = createApp({
      vertexClient,
      vertexModel: 'gemini-2.5-flash',
      vertexProject: 'p',
      vertexLocation: 'us-central1',
    });
    const res = await request(app)
      .post(ANALYZE_PATH)
      .field('metrics', VALID_METRICS)
      .attach('photo', TINY_JPEG, { filename: 'p.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.aiSummary).toBe('Friendly summary.');
    expect(res.body.aiUnavailable).toBeFalsy();
    // Correlation id + timestamp must accompany every analyze response so
    // the client can render them and shared screenshots can be traced back
    // to a specific Cloud Logging entry.
    expect(res.body.id).toMatch(/^[0-9a-f]{8}$/);
    expect(res.body.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(vertexClient.analyze).toHaveBeenCalledTimes(1);
    const call = vertexClient.analyze.mock.calls[0][0];
    expect(Buffer.isBuffer(call.photoBuffer)).toBe(true);
    expect(call.metricsText).toBe(VALID_METRICS);
    expect(call.photoMimeType).toBe('image/jpeg');
  });

  it('returns aiUnavailable=true (still 200) when vertex throws', async () => {
    const app = createApp({
      vertexClient: stubVertexFailure(),
      vertexModel: 'gemini-2.5-flash',
      vertexProject: 'p',
      vertexLocation: 'us-central1',
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app)
      .post(ANALYZE_PATH)
      .field('metrics', VALID_METRICS)
      .attach('photo', TINY_JPEG, { filename: 'p.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.aiUnavailable).toBe(true);
    expect(res.body.aiSummary).toBeUndefined();
    // Even failure responses carry the trace id so the user can report
    // "this request failed" with a specific id.
    expect(res.body.id).toMatch(/^[0-9a-f]{8}$/);
    expect(res.body.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    errSpy.mockRestore();
  });

  it('returns aiUnavailable=true when VERTEX_PROJECT is missing', async () => {
    const app = createApp({
      // No vertexClient and no vertexProject.
      vertexLocation: 'us-central1',
    });
    const res = await request(app)
      .post(ANALYZE_PATH)
      .field('metrics', VALID_METRICS)
      .attach('photo', TINY_JPEG, { filename: 'p.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(200);
    expect(res.body.aiUnavailable).toBe(true);
  });
});

describe('GET /onframe/api/health', () => {
  it('reflects vertexConfigured=false when endpoint is absent', async () => {
    const app = createApp({});
    const res = await request(app).get(HEALTH_PATH);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.vertexConfigured).toBe(false);
  });

  it('reflects vertexConfigured=true when project + model are set', async () => {
    const app = createApp({
      vertexClient: stubVertexSuccess(),
      vertexModel: 'gemini-2.5-flash',
      vertexProject: 'p',
      vertexLocation: 'us-central1',
    });
    const res = await request(app).get(HEALTH_PATH);
    expect(res.status).toBe(200);
    expect(res.body.vertexConfigured).toBe(true);
  });
});

describe('mergePerceptualFindings', () => {
  it('clamps positive deltas to per-category caps (Lighting +30 → +10)', () => {
    const localCards = makeLocalCards({ Lighting: { score: 70 } });
    const merged = mergePerceptualFindings({
      localCards,
      findings: { lighting: { delta: 30, reason: 'Light is great' } },
    });
    const lighting = merged.cards.find((c) => c.category === 'Lighting');
    expect(lighting.score).toBe(80);
    expect(lighting.aiReason).toBe('Light is great');
  });

  it('clamps negative deltas to per-category caps (Eye Contact −50 → −10)', () => {
    const localCards = makeLocalCards({ 'Eye Contact & Gaze': { score: 80 } });
    const merged = mergePerceptualFindings({
      localCards,
      findings: { eyecontact: { delta: -50, reason: 'Gaze feels distant' } },
    });
    const eye = merged.cards.find((c) => c.category === 'Eye Contact & Gaze');
    expect(eye.score).toBe(70);
    expect(eye.aiReason).toBe('Gaze feels distant');
  });

  it('uses the tighter ±5 cap for Head Angle & Pose', () => {
    const localCards = makeLocalCards({ 'Head Angle & Pose': { score: 75 } });
    const merged = mergePerceptualFindings({
      localCards,
      findings: { headpose: { delta: 20, reason: 'Pose reads strong' } },
    });
    const pose = merged.cards.find((c) => c.category === 'Head Angle & Pose');
    expect(pose.score).toBe(80);
    expect(pose.aiReason).toBe('Pose reads strong');
  });

  it('never adjusts Sharpness & Focus even if sharpness finding present', () => {
    const localCards = makeLocalCards({ 'Sharpness & Focus': { score: 65 } });
    const merged = mergePerceptualFindings({
      localCards,
      findings: { sharpness: { delta: 10, reason: 'Looks crisp' } },
    });
    const sharp = merged.cards.find((c) => c.category === 'Sharpness & Focus');
    expect(sharp.score).toBe(65);
    expect(sharp.aiReason).toBeUndefined();
  });

  it('silently ignores unknown finding keys', () => {
    const localCards = makeLocalCards();
    const merged = mergePerceptualFindings({
      localCards,
      findings: { bogus: { delta: 8, reason: 'whatever' } },
    });
    for (const card of merged.cards) {
      expect(card.aiReason).toBeUndefined();
    }
    // Scores unchanged.
    expect(merged.cards.find((c) => c.category === 'Lighting').score).toBe(70);
  });

  it('clamps final per-card score to [0, 100] after delta', () => {
    const high = makeLocalCards({ Lighting: { score: 95 } });
    const mergedHigh = mergePerceptualFindings({
      localCards: high,
      findings: { lighting: { delta: 10, reason: 'beautiful' } },
    });
    expect(mergedHigh.cards.find((c) => c.category === 'Lighting').score).toBe(100);

    const low = makeLocalCards({ Background: { score: 5 } });
    const mergedLow = mergePerceptualFindings({
      localCards: low,
      findings: { background: { delta: -10, reason: 'messy' } },
    });
    expect(mergedLow.cards.find((c) => c.category === 'Background').score).toBe(0);
  });

  it('attaches aiReason only when clamped delta != 0, sanitized to ≤90 chars (mobile-card cap)', () => {
    const longReason = 'x'.repeat(500);
    const localCards = makeLocalCards();
    const merged = mergePerceptualFindings({
      localCards,
      findings: {
        lighting: { delta: 0, reason: 'no movement' },           // zero delta → no aiReason
        composition: { delta: 5, reason: longReason },           // adjusted → trimmed reason
        background: { delta: -3, reason: '   ' },                // empty after trim → no aiReason (or just delta-only)
      },
    });
    const light = merged.cards.find((c) => c.category === 'Lighting');
    expect(light.aiReason).toBeUndefined();
    expect(light.score).toBe(70);

    const comp = merged.cards.find((c) => c.category === 'Composition & Framing');
    expect(comp.aiReason).toHaveLength(90);
    expect(comp.score).toBe(85);

    const bg = merged.cards.find((c) => c.category === 'Background');
    expect(bg.score).toBe(57);
    expect(bg.aiReason).toBeUndefined();
  });

  it('recomputes overallScore from merged cards using existing weights', () => {
    const localCards = makeLocalCards();
    const merged = mergePerceptualFindings({
      localCards,
      findings: {
        lighting: { delta: 10, reason: 'great' },
        composition: { delta: -5, reason: 'cramped' },
      },
    });
    expect(merged.overallScore).toBe(computeOverallScore(merged.cards));
    // Sanity: confirm the recompute reflects merged values, not pre-merge cards.
    const preMergeOverall = computeOverallScore(localCards);
    expect(merged.overallScore).not.toBe(preMergeOverall);
  });

  it('returns null when localCards is missing / not array / wrong shape', () => {
    expect(mergePerceptualFindings({ localCards: null, findings: {} })).toBeNull();
    expect(mergePerceptualFindings({ localCards: undefined, findings: {} })).toBeNull();
    expect(mergePerceptualFindings({ localCards: 'string', findings: {} })).toBeNull();
    expect(mergePerceptualFindings({ localCards: [], findings: {} })).toBeNull();
    expect(mergePerceptualFindings({ localCards: [{ noCategory: true }], findings: {} })).toBeNull();
  });

  it('returns cards untouched + recomputed overall when findings is empty/missing', () => {
    const localCards = makeLocalCards();
    const a = mergePerceptualFindings({ localCards, findings: undefined });
    const b = mergePerceptualFindings({ localCards, findings: {} });
    for (const merged of [a, b]) {
      expect(merged.cards).toHaveLength(6);
      expect(merged.cards.find((c) => c.category === 'Lighting').score).toBe(70);
      expect(merged.cards.find((c) => c.category === 'Lighting').aiReason).toBeUndefined();
      expect(merged.overallScore).toBe(computeOverallScore(merged.cards));
    }
  });

  it('drops findings whose delta is not a finite number', () => {
    const localCards = makeLocalCards();
    const merged = mergePerceptualFindings({
      localCards,
      findings: {
        lighting: { delta: NaN, reason: 'nope' },
        composition: { delta: Infinity, reason: 'nope' },
        background: { delta: '5', reason: 'nope' },
        eyecontact: { reason: 'nope' },               // missing delta
        headpose: { delta: 3, reason: 'good' },       // this one should apply
      },
    });
    expect(merged.cards.find((c) => c.category === 'Lighting').score).toBe(70);
    expect(merged.cards.find((c) => c.category === 'Composition & Framing').score).toBe(80);
    expect(merged.cards.find((c) => c.category === 'Background').score).toBe(60);
    expect(merged.cards.find((c) => c.category === 'Eye Contact & Gaze').score).toBe(72);
    expect(merged.cards.find((c) => c.category === 'Head Angle & Pose').score).toBe(78);
  });
});

// Full cloud-scored card set, in the shape vertex.js now returns.
const CLOUD_CARDS = [
  { category: 'Lighting',              score: 82, title: 'Lighting',              tip: 'Soft key, clean catchlights.',  priority: 3 },
  { category: 'Head Angle & Pose',     score: 78, title: 'Head Angle & Pose',     tip: 'Slight turn reads natural.',     priority: 3 },
  { category: 'Composition & Framing', score: 74, title: 'Composition & Framing', tip: 'Eyes on the upper third.',       priority: 3 },
  { category: 'Sharpness & Focus',     score: 90, title: 'Sharpness & Focus',     tip: 'Eyes and lips crisply in focus.', priority: 3 },
  { category: 'Background',            score: 60, title: 'Background',            tip: 'Mild edge clutter.',             priority: 3 },
  { category: 'Eye Contact & Gaze',    score: 88, title: 'Eye Contact & Gaze',    tip: 'Direct, engaged gaze.',          priority: 3 },
];

describe('POST /onframe/api/analyze — cloud-primary scoring', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns aiSummary + 6 cards + overallScore from Gemini full scores', async () => {
    const vertexClient = {
      analyze: vi.fn().mockResolvedValue({ aiSummary: 'Sharp eyes carry it.', cards: CLOUD_CARDS }),
    };
    const app = createApp({
      vertexClient,
      vertexModel: 'gemini-2.5-flash',
      vertexProject: 'p',
      vertexLocation: 'us-central1',
    });
    const res = await request(app)
      .post(ANALYZE_PATH)
      .field('metrics', VALID_METRICS)
      .attach('photo', TINY_JPEG, { filename: 'p.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.aiSummary).toBe('Sharp eyes carry it.');
    expect(res.body.cards).toHaveLength(6);
    // Gemini now owns sharpness — its score flows straight through.
    const sharp = res.body.cards.find((c) => c.category === 'Sharpness & Focus');
    expect(sharp.score).toBe(90);
    expect(sharp.tip).toMatch(/in focus/i);
    // Weighted overall: 82*.30 + 78*.25 + 74*.20 + 90*.15 + 60*.05 + 88*.05 = 79.8 → 80
    expect(res.body.overallScore).toBe(80);
  });

  it('does not depend on client localCards (server no longer merges)', async () => {
    const vertexClient = {
      analyze: vi.fn().mockResolvedValue({ aiSummary: 'OK.', cards: CLOUD_CARDS }),
    };
    const app = createApp({
      vertexClient, vertexModel: 'gemini-2.5-flash', vertexProject: 'p', vertexLocation: 'us-central1',
    });
    const res = await request(app)
      .post(ANALYZE_PATH)
      .field('metrics', VALID_METRICS) // intentionally no localCards
      .attach('photo', TINY_JPEG, { filename: 'p.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.cards).toHaveLength(6);
    expect(typeof res.body.overallScore).toBe('number');
  });

  it('fills a fallback card for any category Gemini omits', async () => {
    const partial = CLOUD_CARDS.filter((c) => c.category !== 'Background');
    const vertexClient = {
      analyze: vi.fn().mockResolvedValue({ aiSummary: 'Five only.', cards: partial }),
    };
    const app = createApp({
      vertexClient, vertexModel: 'gemini-2.5-flash', vertexProject: 'p', vertexLocation: 'us-central1',
    });
    const res = await request(app)
      .post(ANALYZE_PATH)
      .field('metrics', VALID_METRICS)
      .attach('photo', TINY_JPEG, { filename: 'p.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.cards).toHaveLength(6);
    const bg = res.body.cards.find((c) => c.category === 'Background');
    expect(bg).toBeTruthy();
    expect(bg.score).toBe(0); // fallback card
  });

  it('returns only aiSummary when vertex returns no cards', async () => {
    const vertexClient = {
      analyze: vi.fn().mockResolvedValue({ aiSummary: 'Summary only.' }),
    };
    const app = createApp({
      vertexClient, vertexModel: 'gemini-2.5-flash', vertexProject: 'p', vertexLocation: 'us-central1',
    });
    const res = await request(app)
      .post(ANALYZE_PATH)
      .field('metrics', VALID_METRICS)
      .attach('photo', TINY_JPEG, { filename: 'p.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.aiSummary).toBe('Summary only.');
    expect(res.body.cards).toBeUndefined();
    expect(res.body.overallScore).toBeUndefined();
  });

  it('zeroes the photo buffer in finally even when cloud scoring runs', async () => {
    let capturedBuffer = null;
    const vertexClient = {
      analyze: vi.fn().mockImplementation(async ({ photoBuffer }) => {
        capturedBuffer = photoBuffer;
        return { aiSummary: 'OK.', cards: CLOUD_CARDS };
      }),
    };
    const app = createApp({
      vertexClient, vertexModel: 'gemini-2.5-flash', vertexProject: 'p', vertexLocation: 'us-central1',
    });
    const res = await request(app)
      .post(ANALYZE_PATH)
      .field('metrics', VALID_METRICS)
      .attach('photo', TINY_JPEG, { filename: 'p.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(capturedBuffer).not.toBeNull();
    expect(Array.from(capturedBuffer)).toEqual(new Array(capturedBuffer.length).fill(0));
  });
});

describe('POST /onframe/api/report', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not log photo or metrics fields even if posted', async () => {
    const app = createApp({ vertexClient: stubVertexSuccess() });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const res = await request(app)
      .post(REPORT_PATH)
      .set('Content-Type', 'application/json')
      .send({
        id: 'r1',
        userText: 'looks ok',
        overallScore: 70,
        photoType: 'close-up',
        cardScores: [{ category: 'Lighting', score: 70 }],
        photo: 'BASE64IMAGEDATA_SHOULD_NOT_LOG',
        metrics: { secret: 'DO_NOT_LOG_METRICS' },
      });

    expect(res.status).toBe(200);
    const logged = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(logged).not.toContain('BASE64IMAGEDATA_SHOULD_NOT_LOG');
    expect(logged).not.toContain('DO_NOT_LOG_METRICS');
    logSpy.mockRestore();
  });

  it('never logs the original filename from fileInfo (PII)', async () => {
    const app = createApp({ vertexClient: stubVertexSuccess() });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const res = await request(app)
      .post(REPORT_PATH)
      .set('Content-Type', 'application/json')
      .send({
        id: 'r2',
        userText: 'broke',
        context: 'error',
        fileInfo: { size: 1234, type: 'image/jpeg', name: 'JaneDoe-passport-selfie.jpg', ext: '.jpg' },
        error: { stage: 'analyzeImage', message: 'boom', fileInfo: { name: 'JaneDoe-passport-selfie.jpg' } },
        device: { ua: 'x'.repeat(5000), screen: '1x1', dpr: 2, memory: 8, cores: 8 },
      });

    expect(res.status).toBe(200);
    const logged = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    // Filename (and any basename) must never reach the logs, top-level or nested in error.
    expect(logged).not.toContain('JaneDoe-passport-selfie');
    // Oversized UA must be truncated, not logged verbatim.
    expect(logged).not.toContain('x'.repeat(5000));
    logSpy.mockRestore();
  });
});

describe('sniffImageMime', () => {
  it('identifies JPEG by FF D8 FF magic bytes', () => {
    expect(sniffImageMime(TINY_JPEG)).toBe('image/jpeg');
  });
  it('identifies WEBP by RIFF....WEBP magic bytes', () => {
    expect(sniffImageMime(TINY_WEBP)).toBe('image/webp');
  });
  it('returns null for non-image bytes', () => {
    expect(sniffImageMime(NOT_AN_IMAGE)).toBeNull();
  });
  it('returns null for non-buffer / empty input', () => {
    expect(sniffImageMime(null)).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
  });
});

describe('POST /onframe/api/analyze — content sniffing', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns 400 when bytes do not match an allowed image despite image/jpeg content type', async () => {
    const vertexClient = stubVertexSuccess();
    const app = createApp({
      vertexClient,
      vertexModel: 'gemini-2.5-flash',
      vertexProject: 'p',
      vertexLocation: 'us-central1',
    });
    const res = await request(app)
      .post(ANALYZE_PATH)
      .field('metrics', VALID_METRICS)
      .attach('photo', NOT_AN_IMAGE, { filename: 'p.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    // Must reject before spending a Vertex call.
    expect(vertexClient.analyze).not.toHaveBeenCalled();
  });

  it('accepts a real WEBP payload labelled image/webp', async () => {
    const app = createApp({
      vertexClient: stubVertexSuccess(),
      vertexModel: 'gemini-2.5-flash',
      vertexProject: 'p',
      vertexLocation: 'us-central1',
    });
    const res = await request(app)
      .post(ANALYZE_PATH)
      .field('metrics', VALID_METRICS)
      .attach('photo', TINY_WEBP, { filename: 'p.webp', contentType: 'image/webp' });
    expect(res.status).toBe(200);
  });
});

describe('sanitizeReportFileInfo / sanitizeReportDevice', () => {
  it('drops the filename and keeps only size/type/ext', () => {
    const out = sanitizeReportFileInfo({ size: 99, type: 'image/jpeg', name: 'secret-name.jpg', ext: '.jpg' });
    expect(out).toEqual({ size: 99, type: 'image/jpeg', ext: '.jpg' });
    expect(out).not.toHaveProperty('name');
  });
  it('caps device fields and coerces numerics', () => {
    const out = sanitizeReportDevice({ ua: 'a'.repeat(1000), screen: '1920x1080', dpr: '2', memory: 8, cores: 'x' });
    expect(out.ua.length).toBeLessThanOrEqual(256);
    expect(out.dpr).toBe(2);
    expect(out.cores).toBeNull();
  });
  it('returns null for non-object input', () => {
    expect(sanitizeReportFileInfo(null)).toBeNull();
    expect(sanitizeReportDevice('nope')).toBeNull();
  });
});

describe('POST /onframe/api/analyze — global cost cap', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns 429 once the global cap is hit, regardless of client IP', async () => {
    const app = createApp({
      vertexClient: stubVertexSuccess(),
      vertexModel: 'gemini-2.5-flash',
      vertexProject: 'p',
      vertexLocation: 'us-central1',
      trustProxy: true,
      globalRateMax: 2,
    });
    const fire = (ip) => request(app)
      .post(ANALYZE_PATH)
      .set('X-Forwarded-For', ip)
      .field('metrics', VALID_METRICS)
      .attach('photo', TINY_JPEG, { filename: 'p.jpg', contentType: 'image/jpeg' });

    // Three distinct IPs: per-IP limiter (max 10) would let all through, but
    // the global cap of 2 must reject the third.
    const r1 = await fire('1.1.1.1');
    const r2 = await fire('2.2.2.2');
    const r3 = await fire('3.3.3.3');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
    expect(r3.body.error).toBeTruthy();
  });
});
