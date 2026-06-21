/**
 * cloudContext.js — builds the neutral context sent to the cloud (Vertex) scorer.
 *
 * CLOUD-PRIMARY INVARIANT: the perceptual scorer judges every appearance axis
 * (sharpness, lighting, background, colour, expression) from the IMAGE. It must
 * NOT be handed the local synthesizer's category scores, nor the on-device
 * quality measurements — the local sharpness is a Laplacian/texture proxy that
 * false-negatives smooth-skin / shallow-DoF faces, and feeding it (or any score)
 * into the prompt makes the model ANCHOR to it and parrot a wrong score back.
 *
 * So we send only reliable GEOMETRY the model genuinely can't recover from a
 * single 2D frame — head angles and framing — and nothing that encodes a
 * verdict about how the photo looks.
 */

const r2d = (r) => (Number(r) * 180 / Math.PI).toFixed(1);
const pct = (v) => (Number(v) * 100).toFixed(1) + '%';

/**
 * Geometry-only context string. Deliberately excludes every sharpness/quality/
 * appearance measurement (faceQualityScore, *EyeSharpness, skinSmoothness,
 * lighting ratio/exposure, background brightness, colour cast, expression flags).
 */
export function buildCloudContext(m) {
  if (!m) return '';
  return [
    `Face detected: ${m.faceDetected}`,
    `Image: ${m.imageWidthPx}×${m.imageHeightPx}px`,
    `Head yaw: ${r2d(m.faceYawAngle)}° (${m.viewTypeName})`,
    `Head pitch: ${r2d(m.facePitchAngle)}°  roll: ${r2d(m.faceRollAngle)}°`,
    `Face framing: ${pct(m.faceFramingRatio)} of frame`,
    `Eyeline Y: ${Number(m.eyelineYPosition).toFixed(3)}  horizontal offset: ${Number(m.horizontalOffset).toFixed(3)}`,
    `Headroom ratio: ${Number(m.headroomRatio).toFixed(3)}  crop safety: ${m.cropLineSafety}`,
    `Lead-room violation: ${m.leadRoomViolation}`,
  ].join('\n');
}

/**
 * The payload posted to the server for live cloud scoring. Only neutral geometry
 * + the framing classification — NO synthesized scores (localScores/localCards).
 */
export function buildCloudPayload(metrics, photoType) {
  return {
    summary: buildCloudContext(metrics),
    photoType: photoType ?? null,
  };
}
