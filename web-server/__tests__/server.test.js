import { describe, it, expect, vi, afterEach } from 'vitest';
import serverModule from '../server.js';

const {
  analyzeSummary,
  computeOverallScore,
  createApp,
  normalizeAiResponse,
  normalizeBasePath,
  normalizeSummary,
  parseTrustProxy,
  sanitizeCard,
  sanitizeGearNeeded,
} = serverModule;

function groqResponse(overallScore = 80, cards = null) {
  const defaultCards = [
    { category: 'Lighting', score: 80, title: 'Good', tip: 'Fine', priority: 3, requiresGear: false },
  ];
  const content = JSON.stringify({
    overallScore,
    cards: cards || defaultCards,
  });
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content } }],
    }),
  };
}

const VALID_SUMMARY = 'This is a portrait photo with good lighting and composition details.';

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

describe('analyzeSummary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects invalid summaries', async () => {
    await expect(analyzeSummary({
      summary: 'short',
      groqApiKey: 'test-key',
      fetchImpl: vi.fn(),
    })).rejects.toMatchObject({ status: 400 });
  });

  it('rejects when the API key is missing', async () => {
    await expect(analyzeSummary({
      summary: VALID_SUMMARY,
      groqApiKey: '',
      fetchImpl: vi.fn(),
    })).rejects.toMatchObject({ status: 503 });
  });

  it('sends the trimmed summary to Groq', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(groqResponse());
    await analyzeSummary({
      summary: `   ${VALID_SUMMARY}   `,
      groqApiKey: 'test-key',
      fetchImpl,
    });

    const [, options] = fetchImpl.mock.calls[0];
    const parsedBody = JSON.parse(options.body);
    expect(parsedBody.messages[1].content).toBe(VALID_SUMMARY);
  });

  it('returns sanitized Groq results', async () => {
    const result = await analyzeSummary({
      summary: VALID_SUMMARY,
      groqApiKey: 'test-key',
      fetchImpl: vi.fn().mockResolvedValue(groqResponse(82, [
        {
          category: 'Lighting',
          score: 82,
          title: 'Use softer window light',
          tip: 'Step closer to the window and soften the light with a curtain.',
          priority: 2,
          gearNeeded: [' reflector ', '', 'gear', 'softbox'],
          requiresGear: true,
        },
      ])),
    });

    expect(result.overallScore).toBe(computeOverallScore(result.cards));
    expect(result.cards[0].gearNeeded).toEqual(['reflector', 'softbox']);
  });

  it('maps fetch failures to a 503 error', async () => {
    await expect(analyzeSummary({
      summary: VALID_SUMMARY,
      groqApiKey: 'test-key',
      fetchImpl: vi.fn().mockRejectedValue(new Error('timeout')),
    })).rejects.toMatchObject({ status: 503, publicMessage: expect.stringContaining('timeout') });
  });

  it('maps non-ok Groq responses to a 503 error', async () => {
    await expect(analyzeSummary({
      summary: VALID_SUMMARY,
      groqApiKey: 'test-key',
      fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 429 }),
    })).rejects.toMatchObject({ status: 503, publicMessage: expect.stringContaining('rate limited') });
  });

  it('maps malformed JSON responses to a 500 error', async () => {
    await expect(analyzeSummary({
      summary: VALID_SUMMARY,
      groqApiKey: 'test-key',
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'not json' } }] }),
      }),
    })).rejects.toMatchObject({ status: 500, publicMessage: expect.stringContaining('parse') });
  });

  it('maps missing required fields to a 500 error', async () => {
    await expect(analyzeSummary({
      summary: VALID_SUMMARY,
      groqApiKey: 'test-key',
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ foo: 'bar' }) } }] }),
      }),
    })).rejects.toMatchObject({ status: 500, publicMessage: expect.stringContaining('missing required fields') });
  });
});

describe('createApp', () => {
  it('returns an express application function', () => {
    const app = createApp({ groqApiKey: 'test-key' });
    expect(typeof app).toBe('function');
    expect(typeof app.use).toBe('function');
    expect(typeof app.post).toBe('function');
  });

  it('applies trust proxy parsing to express settings', () => {
    const app = createApp({ groqApiKey: 'test-key', trustProxy: '2' });
    expect(app.get('trust proxy')).toBe(2);
  });

  it('registers health and analyze routes under the normalized base path', () => {
    const app = createApp({ groqApiKey: 'test-key', basePath: '/prod/' });
    const routes = app._router.stack
      .filter((layer) => layer.route)
      .map((layer) => layer.route.path);

    expect(routes).toContain('/prod/onframe/api/health');
    expect(routes).toContain('/prod/onframe/api/analyze');
  });
});
