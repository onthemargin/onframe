import { describe, it, expect } from 'vitest';
import { computeHeadroomRatio, classifyPhotoType } from '../composition.js';

// Helper: create a minimal landmarks array with only the points
// computeHeadroomRatio needs (lm10 = forehead, lm152 = chin).
function makeLandmarks({ foreheadY, chinY }) {
  const lm = new Array(478).fill(null).map(() => ({ x: 0.5, y: 0.5 }));
  lm[10]  = { x: 0.5, y: foreheadY };
  lm[152] = { x: 0.5, y: chinY };
  return lm;
}

describe('computeHeadroomRatio', () => {
  it('returns less than forehead Y to account for hair above hairline', () => {
    // Forehead at 30% down, chin at 65% — face height = 0.35
    // Hair extends above the forehead, so actual head top is higher.
    // headroomRatio should be < landmarks[10].y
    const lm = makeLandmarks({ foreheadY: 0.30, chinY: 0.65 });
    const ratio = computeHeadroomRatio(lm);
    expect(ratio).toBeLessThan(0.30);
  });

  it('never returns negative even when forehead is near top of frame', () => {
    const lm = makeLandmarks({ foreheadY: 0.03, chinY: 0.40 });
    const ratio = computeHeadroomRatio(lm);
    expect(ratio).toBeGreaterThanOrEqual(0);
  });

  it('returns higher values when face is further down in the frame', () => {
    const high = makeLandmarks({ foreheadY: 0.15, chinY: 0.50 });
    const low  = makeLandmarks({ foreheadY: 0.40, chinY: 0.75 });
    expect(computeHeadroomRatio(low)).toBeGreaterThan(computeHeadroomRatio(high));
  });
});

describe('classifyPhotoType', () => {
  it('classifies close-up headshot (face >= 35% of frame)', () => {
    expect(classifyPhotoType(0.50)).toEqual({ type: 'closeup', label: 'Close-up headshot' });
    expect(classifyPhotoType(0.35)).toEqual({ type: 'closeup', label: 'Close-up headshot' });
  });

  it('classifies head-and-shoulders (15-35%)', () => {
    expect(classifyPhotoType(0.25)).toEqual({ type: 'head-and-shoulders', label: 'Head & shoulders' });
    expect(classifyPhotoType(0.15)).toEqual({ type: 'head-and-shoulders', label: 'Head & shoulders' });
  });

  it('classifies half-length (5-15%)', () => {
    expect(classifyPhotoType(0.10)).toEqual({ type: 'half-length', label: 'Half-length' });
    expect(classifyPhotoType(0.05)).toEqual({ type: 'half-length', label: 'Half-length' });
  });

  it('classifies three-quarter (2-5%)', () => {
    expect(classifyPhotoType(0.03)).toEqual({ type: 'three-quarter', label: 'Three-quarter' });
  });

  it('classifies full-length (< 2%)', () => {
    expect(classifyPhotoType(0.01)).toEqual({ type: 'full-length', label: 'Full-length' });
  });
});
