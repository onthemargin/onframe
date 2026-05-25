import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock downscale so cloud.js's call to it always returns a known blob.
vi.mock('../downscale.js', () => ({
  downscaleImage: vi.fn(async (file) => new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' })),
}));

import { fetchCloudCoaching } from '../cloud.js';
import { downscaleImage } from '../downscale.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile() {
  return new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'image/jpeg' });
}

function makeMetrics(overrides = {}) {
  return {
    summary: 'Measured portrait summary.',
    humanReadableSummary: 'Measured portrait summary.',
    photoType: 'head-and-shoulders',
    localScores: { lighting: 70, composition: 80 },
    localCards: [{ category: 'Lighting', score: 70 }],
    ...overrides,
  };
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

function brokenJsonResponse({ ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => { throw new Error('not json'); },
  };
}

beforeEach(() => {
  downscaleImage.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.fetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fetchCloudCoaching', () => {
  it('calls fetch exactly once with method POST and a FormData body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ aiSummary: 'great shot' }));
    globalThis.fetch = fetchMock;

    await fetchCloudCoaching(makeFile(), makeMetrics());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('attaches both photo and metrics fields to the FormData body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ aiSummary: 'ok' }));
    globalThis.fetch = fetchMock;

    await fetchCloudCoaching(makeFile(), makeMetrics());

    const fd = fetchMock.mock.calls[0][1].body;
    expect(fd.has('photo')).toBe(true);
    expect(fd.has('metrics')).toBe(true);
  });

  it('encodes the metrics field as JSON containing summary, photoType, localScores, localCards', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ aiSummary: 'ok' }));
    globalThis.fetch = fetchMock;

    await fetchCloudCoaching(makeFile(), makeMetrics({
      summary: 'Cool portrait.',
      photoType: 'three-quarter',
      localScores: { lighting: 65 },
      localCards: [{ category: 'Lighting', score: 65 }],
    }));

    const fd = fetchMock.mock.calls[0][1].body;
    const parsed = JSON.parse(fd.get('metrics'));
    expect(parsed.summary).toBe('Cool portrait.');
    expect(parsed.photoType).toBe('three-quarter');
    expect(parsed.localScores).toEqual({ lighting: 65 });
    expect(parsed.localCards).toEqual([{ category: 'Lighting', score: 65 }]);
  });

  it('returns the parsed JSON on a 200 response', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ aiSummary: 'looks great' }));

    const result = await fetchCloudCoaching(makeFile(), makeMetrics());
    expect(result).toEqual({ aiSummary: 'looks great' });
  });

  it('returns { aiUnavailable: true } when fetch rejects (network failure)', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('network down'); });

    const result = await fetchCloudCoaching(makeFile(), makeMetrics());
    expect(result).toEqual({ aiUnavailable: true });
  });

  it('returns { aiUnavailable: true } when the response body is not valid JSON', async () => {
    globalThis.fetch = vi.fn(async () => brokenJsonResponse({ ok: true, status: 200 }));

    const result = await fetchCloudCoaching(makeFile(), makeMetrics());
    expect(result).toEqual({ aiUnavailable: true });
  });

  it('returns { aiUnavailable: true } when the response status is non-OK', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: 'boom' }, { ok: false, status: 500 }));

    const result = await fetchCloudCoaching(makeFile(), makeMetrics());
    expect(result).toEqual({ aiUnavailable: true });
  });

  it('returns { aiUnavailable: true } and skips fetch when humanReadableSummary/summary is missing', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ aiSummary: 'should not happen' }));
    globalThis.fetch = fetchMock;

    const result = await fetchCloudCoaching(makeFile(), { photoType: 'head-and-shoulders' });

    expect(result).toEqual({ aiUnavailable: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns { aiUnavailable: true } and skips fetch when the file is not a Blob', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ aiSummary: 'nope' }));
    globalThis.fetch = fetchMock;

    const result = await fetchCloudCoaching(null, makeMetrics());

    expect(result).toEqual({ aiUnavailable: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls downscaleImage before posting', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ aiSummary: 'ok' }));

    await fetchCloudCoaching(makeFile(), makeMetrics());

    expect(downscaleImage).toHaveBeenCalledTimes(1);
  });

  it('returns aiSummary, cards, and overallScore unchanged when server provides all three', async () => {
    const body = {
      aiSummary: 'engaged and natural',
      cards: [
        { category: 'Lighting', score: 64, title: 'Soft light', tip: 'Turn slightly', priority: 2, gearNeeded: [], aiReason: 'Reads flat.' },
        { category: 'Composition & Framing', score: 70, title: 'Frame', tip: 'Recompose', priority: 2, gearNeeded: [] },
      ],
      overallScore: 71,
    };
    globalThis.fetch = vi.fn(async () => jsonResponse(body));

    const result = await fetchCloudCoaching(makeFile(), makeMetrics());

    expect(result).toEqual(body);
    expect(result.cards).toHaveLength(2);
    expect(result.overallScore).toBe(71);
  });

  it('returns only aiSummary (no cards/overallScore) when server returns aiSummary only', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ aiSummary: 'just a summary' }));

    const result = await fetchCloudCoaching(makeFile(), makeMetrics());

    expect(result).toEqual({ aiSummary: 'just a summary' });
    expect(result.cards).toBeUndefined();
    expect(result.overallScore).toBeUndefined();
  });

  it('returns { aiUnavailable: true } unchanged when server explicitly signals it', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ aiUnavailable: true }));

    const result = await fetchCloudCoaching(makeFile(), makeMetrics());

    expect(result).toEqual({ aiUnavailable: true });
  });
});
