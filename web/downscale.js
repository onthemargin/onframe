/**
 * downscale.js — Client-side image downscaling for cloud upload.
 *
 * Decodes the input file, scales it so the longest edge is ≤ maxEdge,
 * draws to a canvas, and re-encodes as JPEG. The re-encode step strips
 * EXIF/orientation metadata — we never return the original bytes.
 */

/**
 * Compute the post-scale (width, height) so the longer edge is at most maxEdge.
 * Never upscales — small images pass through unchanged.
 */
export function computeTargetSize(width, height, maxEdge) {
  const longest = Math.max(width, height);
  if (!longest || longest <= maxEdge) {
    return { width, height };
  }
  const scale = maxEdge / longest;
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
}

/**
 * Decode a File/Blob, scale it, and re-encode as JPEG.
 * Returns a Blob. Throws on decode failure.
 */
export async function downscaleImage(file, {
  maxEdge = 1280,
  quality = 0.85,
  mimeType = 'image/jpeg',
} = {}) {
  if (!file || (typeof Blob !== 'undefined' && !(file instanceof Blob))) {
    throw new Error('downscaleImage: expected a Blob or File');
  }

  let bitmap;
  try {
    bitmap = await decodeImage(file);
  } catch (err) {
    throw new Error(`downscaleImage: could not decode image (${err?.message || err})`);
  }

  const { width: targetW, height: targetH } = computeTargetSize(bitmap.width, bitmap.height, maxEdge);
  const canvas = createCanvas(targetW, targetH);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('downscaleImage: 2d context unavailable');
  }
  ctx.drawImage(bitmap, 0, 0, targetW, targetH);

  // Release bitmap memory when supported.
  if (typeof bitmap.close === 'function') {
    try { bitmap.close(); } catch (_) { /* ignore */ }
  }

  return await canvasToBlob(canvas, mimeType, quality);
}

// ─── Internals ───────────────────────────────────────────────────────────────

async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    return await createImageBitmap(file);
  }
  // Fallback: <img> + object URL. Works in jsdom-less environments only when
  // the runtime provides Image + URL.createObjectURL.
  if (typeof Image === 'function' && typeof URL !== 'undefined' && URL.createObjectURL) {
    return await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = (e) => {
        URL.revokeObjectURL(url);
        reject(new Error('image load failed'));
      };
      img.src = url;
    });
  }
  throw new Error('no image decoder available');
}

function createCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') {
    return new OffscreenCanvas(width, height);
  }
  if (typeof document !== 'undefined' && document.createElement) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error('downscaleImage: no canvas available');
}

async function canvasToBlob(canvas, mimeType, quality) {
  if (typeof canvas.convertToBlob === 'function') {
    return await canvas.convertToBlob({ type: mimeType, quality });
  }
  if (typeof canvas.toBlob === 'function') {
    return await new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('toBlob returned null'))),
        mimeType,
        quality,
      );
    });
  }
  throw new Error('downscaleImage: no blob encoder available');
}
