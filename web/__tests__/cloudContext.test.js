import { describe, it, expect } from 'vitest';
import { buildCloudContext, buildCloudPayload } from '../cloudContext.js';

// Full metrics fixture (radians for angles, 0–1 for ratios) mirroring analyze output.
const METRICS = {
  faceDetected: true,
  imageWidthPx: 1152, imageHeightPx: 1536,
  faceYawAngle: 0.12, facePitchAngle: -0.05, faceRollAngle: 0.14, viewTypeName: 'three-quarter',
  exposureEV: -0.3, lightingRatio: 3.2, lightingDirection: 'left', lightingPattern: 'loop',
  lightingBroadShort: 'short', hasCatchlights: true, catchlightClockHour: 10,
  colorCastWarmth: 0.04, colorCastGreenShift: -0.01, skinSmoothness: 0.62,
  faceQualityScore: 0.18, leftEyeSharpness: 0.2, rightEyeSharpness: 0.16, nearEyeSharpness: 0.19,
  faceFramingRatio: 0.34, eyelineYPosition: 0.38, horizontalOffset: -0.02,
  headroomRatio: 0.12, cropLineSafety: 'safe', leadRoomViolation: false,
  backgroundBrightness: 0.55, squinchRatio: 0.3, isSquinching: true, isWideEyed: false,
  inferiorScleralShow: 0.1, isSmiling: true, isDuchenneSmile: true, lipGapRatio: 0.02,
};

describe('buildCloudContext — only neutral geometry reaches the cloud scorer', () => {
  const ctx = buildCloudContext(METRICS);

  it('includes the reliable geometry the model cannot get from one 2D image', () => {
    expect(ctx).toMatch(/yaw/i);
    expect(ctx).toMatch(/pitch/i);
    expect(ctx).toMatch(/roll/i);
    expect(ctx).toMatch(/fram/i);      // framing
    expect(ctx).toMatch(/eyeline/i);
    expect(ctx).toMatch(/headroom/i);
  });

  it('NEVER leaks the unreliable sharpness/quality metrics (the anchoring bug)', () => {
    expect(ctx).not.toMatch(/sharp/i);       // faceQuality / eye sharpness
    expect(ctx).not.toMatch(/smoothness/i);  // skin smoothness
    expect(ctx).not.toMatch(/quality/i);
  });

  it('does not leak appearance verdicts the cloud must judge from pixels', () => {
    expect(ctx).not.toMatch(/lighting ratio/i);
    expect(ctx).not.toMatch(/exposure/i);
    expect(ctx).not.toMatch(/background brightness/i);
    expect(ctx).not.toMatch(/color cast/i);
    expect(ctx).not.toMatch(/duchenne/i);
  });
});

describe('buildCloudPayload — no synthesized scores travel to the cloud', () => {
  const payload = buildCloudPayload(METRICS, 'Head & shoulders');

  it('carries only geometry summary + photoType', () => {
    expect(payload.photoType).toBe('Head & shoulders');
    expect(typeof payload.summary).toBe('string');
    expect(payload.summary).toMatch(/yaw/i);
  });

  it('has NO localScores or localCards keys', () => {
    expect(payload).not.toHaveProperty('localScores');
    expect(payload).not.toHaveProperty('localCards');
  });

  it('defaults photoType to null when absent', () => {
    expect(buildCloudPayload(METRICS, undefined).photoType).toBeNull();
  });
});
