import { describe, it, expect, vi } from 'vitest';
import { createVertexClient, DEFAULT_MODEL, stripPlusSignedIntegers } from '../vertex.js';

const PROJECT = 'test-project';
const LOCATION = 'us-central1';
const MODEL = 'gemini-2.5-flash';
const PHOTO_BUFFER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const METRICS_TEXT = '{"summary":"portrait","photoType":"head-and-shoulders"}';

function generateContentResponse(text, finishReason = 'STOP') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [
        { content: { role: 'model', parts: [{ text }] }, finishReason },
      ],
    }),
  };
}

function makeClient(overrides = {}) {
  return createVertexClient({
    project: PROJECT,
    location: LOCATION,
    model: MODEL,
    getAccessToken: vi.fn().mockResolvedValue('test-token'),
    fetchImpl: vi.fn().mockResolvedValue(
      generateContentResponse(JSON.stringify({ aiSummary: 'Looks great.' }))
    ),
    ...overrides,
  });
}

describe('stripPlusSignedIntegers', () => {
  it('strips leading + on integers inside JSON-shape text', () => {
    const input = '{"delta": +3, "values":[+5, -2, +10]}';
    const out = stripPlusSignedIntegers(input);
    expect(out).toBe('{"delta": 3, "values":[5, -2, 10]}');
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('leaves normal JSON untouched', () => {
    const input = '{"a":1,"b":-5,"c":"x+y"}';
    expect(stripPlusSignedIntegers(input)).toBe('{"a":1,"b":-5,"c":"x+y"}');
  });

  it('does not strip + inside string values', () => {
    // The pattern only matches + preceded by a JSON position marker, so a +
    // inside a string with no preceding [ : , whitespace stays.
    const input = '{"note":"a+b"}';
    expect(stripPlusSignedIntegers(input)).toBe('{"note":"a+b"}');
  });
});

describe('createVertexClient.analyze', () => {
  it('POSTs to the Gemini generateContent endpoint with a bearer token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      generateContentResponse(JSON.stringify({ aiSummary: 'Looks great.' }))
    );
    const client = makeClient({ fetchImpl });

    await client.analyze({
      photoBuffer: PHOTO_BUFFER,
      metricsText: METRICS_TEXT,
      photoMimeType: 'image/jpeg',
    });

    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`
    );
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe('Bearer test-token');
    expect(options.headers['Content-Type']).toBe('application/json');
  });

  it('defaults to gemini-2.5-flash when no model is provided', async () => {
    expect(DEFAULT_MODEL).toBe('gemini-2.5-flash');
    const fetchImpl = vi.fn().mockResolvedValue(
      generateContentResponse(JSON.stringify({ aiSummary: 'OK.' }))
    );
    const client = createVertexClient({
      project: PROJECT,
      location: LOCATION,
      getAccessToken: vi.fn().mockResolvedValue('test-token'),
      fetchImpl,
    });
    await client.analyze({
      photoBuffer: PHOTO_BUFFER,
      metricsText: METRICS_TEXT,
      photoMimeType: 'image/jpeg',
    });
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain('/models/gemini-2.5-flash:generateContent');
  });

  it('includes inline base64 image and metricsText in the request body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      generateContentResponse(JSON.stringify({ aiSummary: 'OK.' }))
    );
    const client = makeClient({ fetchImpl });

    await client.analyze({
      photoBuffer: PHOTO_BUFFER,
      metricsText: METRICS_TEXT,
      photoMimeType: 'image/jpeg',
    });

    const [, options] = fetchImpl.mock.calls[0];
    const body = JSON.parse(options.body);
    const parts = body.contents[0].parts;
    expect(parts.some((p) => p.text && p.text.includes(METRICS_TEXT))).toBe(true);
    const inline = parts.find((p) => p.inlineData);
    expect(inline.inlineData.mimeType).toBe('image/jpeg');
    expect(inline.inlineData.data).toBe(PHOTO_BUFFER.toString('base64'));
    expect(body.generationConfig.responseMimeType).toBe('application/json');
  });

  it('returns aiSummary when Gemini returns valid JSON', async () => {
    const client = makeClient({
      fetchImpl: vi.fn().mockResolvedValue(
        generateContentResponse(JSON.stringify({ aiSummary: 'Nice portrait.' }))
      ),
    });

    const result = await client.analyze({
      photoBuffer: PHOTO_BUFFER,
      metricsText: METRICS_TEXT,
      photoMimeType: 'image/jpeg',
    });
    expect(result.aiSummary).toBe('Nice portrait.');
  });

  it('parses markdown-fenced JSON output', async () => {
    const fenced = '```json\n' + JSON.stringify({ aiSummary: 'Fenced ok.' }) + '\n```';
    const client = makeClient({
      fetchImpl: vi.fn().mockResolvedValue(generateContentResponse(fenced)),
    });

    const result = await client.analyze({
      photoBuffer: PHOTO_BUFFER,
      metricsText: METRICS_TEXT,
      photoMimeType: 'image/jpeg',
    });
    expect(result.aiSummary).toBe('Fenced ok.');
  });

  it('throws when output is not parseable JSON', async () => {
    const client = makeClient({
      fetchImpl: vi.fn().mockResolvedValue(generateContentResponse('not json at all')),
    });
    await expect(client.analyze({
      photoBuffer: PHOTO_BUFFER,
      metricsText: METRICS_TEXT,
      photoMimeType: 'image/jpeg',
    })).rejects.toThrow();
  });

  it('attaches finishReason and contentLength to parse-failure errors', async () => {
    // Truncated JSON simulates MAX_TOKENS cutoff mid-string.
    const truncated = '{"aiSummary":"Lorem ipsum dolor sit amet, consectetur adip';
    const client = makeClient({
      fetchImpl: vi.fn().mockResolvedValue(generateContentResponse(truncated, 'MAX_TOKENS')),
    });
    try {
      await client.analyze({
        photoBuffer: PHOTO_BUFFER,
        metricsText: METRICS_TEXT,
        photoMimeType: 'image/jpeg',
      });
      throw new Error('analyze should have thrown');
    } catch (err) {
      expect(err.finishReason).toBe('MAX_TOKENS');
      expect(err.contentLength).toBe(truncated.length);
      expect(err.message).toMatch(/not valid JSON/i);
    }
  });

  it('throws when aiSummary is missing', async () => {
    const client = makeClient({
      fetchImpl: vi.fn().mockResolvedValue(
        generateContentResponse(JSON.stringify({ notSummary: 'oops' }))
      ),
    });
    await expect(client.analyze({
      photoBuffer: PHOTO_BUFFER,
      metricsText: METRICS_TEXT,
      photoMimeType: 'image/jpeg',
    })).rejects.toThrow();
  });

  it('throws on non-200 Vertex response', async () => {
    const client = makeClient({
      fetchImpl: vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => '',
      }),
    });
    await expect(client.analyze({
      photoBuffer: PHOTO_BUFFER,
      metricsText: METRICS_TEXT,
      photoMimeType: 'image/jpeg',
    })).rejects.toThrow();
  });

  it('throws on timeout / abort', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const client = makeClient({
      fetchImpl: vi.fn().mockRejectedValue(abortErr),
    });
    await expect(client.analyze({
      photoBuffer: PHOTO_BUFFER,
      metricsText: METRICS_TEXT,
      photoMimeType: 'image/jpeg',
    })).rejects.toThrow();
  });

  it('throws when aiSummary exceeds 500 chars', async () => {
    const client = makeClient({
      fetchImpl: vi.fn().mockResolvedValue(
        generateContentResponse(JSON.stringify({ aiSummary: 'a'.repeat(501) }))
      ),
    });
    await expect(client.analyze({
      photoBuffer: PHOTO_BUFFER,
      metricsText: METRICS_TEXT,
      photoMimeType: 'image/jpeg',
    })).rejects.toThrow();
  });
});
