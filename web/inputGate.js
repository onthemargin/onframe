// inputGate.js
//
// The on-device face gate (no-face / multi-face) protects the LIVE upload path,
// where we can't vouch for what the user picked. Built-in samples are different:
// they're curated and ship with pre-pulled coaching that does NOT depend on
// MediaPipe, so an on-device detection miss (e.g. a candid head-turn or glasses
// the model can't localize) must never block a sample from rendering its cache.
//
// Pure + DOM-free so it can be unit-tested. Returns a rejection
// `{ reason, message }` or null (proceed). Message is user-facing.
export function evaluateInputGate(metrics, { isSample = false } = {}) {
  if (isSample) return null; // curated + cached → never gated

  if (!metrics || !metrics.faceDetected) {
    const w = metrics?.imageWidthPx;
    const h = metrics?.imageHeightPx;
    const dims = w && h ? ` (${w}x${h}px)` : '';
    return {
      reason: 'no-face',
      message: `No face found${dims}. Try a photo where the face is well-lit, facing the camera, and not too far away.`,
    };
  }

  if (metrics.faceCount > 1) {
    return {
      reason: 'multi-face',
      message: `OnFrame is for single-person photos — we found ${metrics.faceCount} people. Try a photo with just one person.`,
    };
  }

  return null;
}
