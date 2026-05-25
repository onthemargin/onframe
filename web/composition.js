/**
 * composition.js — Pure geometry helpers for composition metrics.
 * No browser or MediaPipe dependencies — safe to import in tests.
 */

/**
 * Estimate headroom ratio — the fraction of image height above the head.
 * landmarks[10] is the forehead/hairline, but hair extends above it.
 * We offset upward by 20% of face height (forehead→chin) to approximate
 * the true head top including hair.
 */
export function computeHeadroomRatio(landmarks) {
  const foreheadY = landmarks[10].y;
  const chinY     = landmarks[152].y;
  const faceH     = chinY - foreheadY;
  // Offset upward by 20% of face height to approximate hair/head top
  return Math.max(0, foreheadY - faceH * 0.20);
}

/**
 * Classify photo type from face-to-frame ratio.
 * Returns { type, label } where type is a machine key and label is human-readable.
 */
export function classifyPhotoType(faceFramingRatio) {
  if (faceFramingRatio >= 0.35) return { type: 'closeup',          label: 'Close-up headshot' };
  if (faceFramingRatio >= 0.15) return { type: 'head-and-shoulders', label: 'Head & shoulders' };
  if (faceFramingRatio >= 0.05) return { type: 'half-length',       label: 'Half-length' };
  if (faceFramingRatio >= 0.02) return { type: 'three-quarter',     label: 'Three-quarter' };
  return                               { type: 'full-length',       label: 'Full-length' };
}
