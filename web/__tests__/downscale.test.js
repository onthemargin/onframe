import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeTargetSize, downscaleImage } from '../downscale.js';

// ---------------------------------------------------------------------------
// Pure math helper — exercised without any canvas/DOM stubs.
// ---------------------------------------------------------------------------
describe('computeTargetSize', () => {
  it('downscales a 2000x1500 image so the longest edge is ≤ 1280, preserving aspect ratio', () => {
    const { width, height } = computeTargetSize(2000, 1500, 1280);
    expect(Math.max(width, height)).toBeLessThanOrEqual(1280);
    // Aspect ratio preserved within a pixel of rounding.
    expect(width / height).toBeCloseTo(2000 / 1500, 2);
  });

  it('does not upscale a small image (400x300 stays 400x300)', () => {
    const { width, height } = computeTargetSize(400, 300, 1280);
    expect(width).toBe(400);
    expect(height).toBe(300);
  });

  it('handles portrait orientation correctly (tall image)', () => {
    const { width, height } = computeTargetSize(1500, 3000, 1280);
    expect(Math.max(width, height)).toBeLessThanOrEqual(1280);
    expect(height).toBeGreaterThan(width);
  });
});

// ---------------------------------------------------------------------------
// downscaleImage — exercised against a tiny stubbed canvas pipeline.
// jsdom is unavailable in this repo, so we stub the few APIs we touch:
//   createImageBitmap, OffscreenCanvas (with getContext + convertToBlob).
// ---------------------------------------------------------------------------

function makeBitmapStub(width, height) {
  return { width, height, close: vi.fn() };
}

function installCanvasStubs({ bitmapWidth, bitmapHeight, blobBytes = [0xff, 0xd8, 0xff], outputMime = 'image/jpeg', failDecode = false } = {}) {
  if (failDecode) {
    globalThis.createImageBitmap = vi.fn(() => Promise.reject(new Error('decode-fail')));
  } else {
    globalThis.createImageBitmap = vi.fn(() => Promise.resolve(makeBitmapStub(bitmapWidth, bitmapHeight)));
  }

  // Track the canvas dimensions that downscaleImage requests.
  const seen = { width: null, height: null, drewImage: false };

  class FakeOffscreenCanvas {
    constructor(w, h) {
      seen.width = w;
      seen.height = h;
      this.width = w;
      this.height = h;
    }
    getContext() {
      return {
        drawImage: () => { seen.drewImage = true; },
      };
    }
    async convertToBlob({ type = 'image/png', quality } = {}) {
      // Mimic a Blob — we don't have jsdom Blob, but global Blob exists in node ≥ 18.
      return new Blob([new Uint8Array(blobBytes)], { type: outputMime });
    }
  }

  globalThis.OffscreenCanvas = FakeOffscreenCanvas;

  return seen;
}

function uninstallCanvasStubs() {
  delete globalThis.createImageBitmap;
  delete globalThis.OffscreenCanvas;
}

describe('downscaleImage', () => {
  afterEach(() => {
    uninstallCanvasStubs();
    vi.restoreAllMocks();
  });

  it('downscales a 2000x1500 image to longest edge ≤ 1280 (preserving aspect ratio)', async () => {
    const seen = installCanvasStubs({ bitmapWidth: 2000, bitmapHeight: 1500 });
    const fakeFile = new Blob([new Uint8Array([0, 1, 2, 3])], { type: 'image/jpeg' });

    const out = await downscaleImage(fakeFile, { maxEdge: 1280 });

    expect(Math.max(seen.width, seen.height)).toBeLessThanOrEqual(1280);
    expect(seen.width / seen.height).toBeCloseTo(2000 / 1500, 2);
    expect(out).toBeInstanceOf(Blob);
  });

  it('does not upscale a 400x300 image — output stays 400x300', async () => {
    const seen = installCanvasStubs({ bitmapWidth: 400, bitmapHeight: 300 });
    const fakeFile = new Blob([new Uint8Array([0, 1, 2])], { type: 'image/jpeg' });

    await downscaleImage(fakeFile, { maxEdge: 1280 });

    expect(seen.width).toBe(400);
    expect(seen.height).toBe(300);
  });

  it('always returns a JPEG Blob (not PNG)', async () => {
    installCanvasStubs({ bitmapWidth: 800, bitmapHeight: 600, outputMime: 'image/jpeg' });
    const fakeFile = new Blob([new Uint8Array([0, 1, 2])], { type: 'image/png' });

    const out = await downscaleImage(fakeFile);

    expect(out.type).toBe('image/jpeg');
  });

  it('returns a non-empty Blob (size > 0)', async () => {
    installCanvasStubs({ bitmapWidth: 1600, bitmapHeight: 1200, blobBytes: new Array(2048).fill(0x42) });
    const fakeFile = new Blob([new Uint8Array(8192)], { type: 'image/jpeg' });

    const out = await downscaleImage(fakeFile);

    expect(out.size).toBeGreaterThan(0);
  });

  it('throws a clear error when given a file that cannot be decoded', async () => {
    installCanvasStubs({ bitmapWidth: 0, bitmapHeight: 0, failDecode: true });
    const fakeFile = new Blob([new Uint8Array([0, 1, 2])], { type: 'application/pdf' });

    await expect(downscaleImage(fakeFile)).rejects.toThrow(/decode|image/i);
  });

  it('always re-encodes — output Blob is not byte-identical to input (EXIF stripped)', async () => {
    installCanvasStubs({ bitmapWidth: 1000, bitmapHeight: 800, blobBytes: [0xaa, 0xbb, 0xcc, 0xdd] });
    const inputBytes = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
    const fakeFile = new Blob([inputBytes], { type: 'image/jpeg' });

    const out = await downscaleImage(fakeFile);

    const outBuf = new Uint8Array(await out.arrayBuffer());
    // The downscale path runs the bytes through the canvas, so the output
    // bytes must come from convertToBlob — different from the input bytes.
    expect(Array.from(outBuf)).not.toEqual(Array.from(inputBytes));
  });
});
