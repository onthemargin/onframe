import { describe, it, expect } from 'vitest';
import { evaluateInputGate } from '../inputGate.js';

const faceOk = { faceDetected: true, faceCount: 1, imageWidthPx: 750, imageHeightPx: 1000 };
const noFace = { faceDetected: false, faceCount: 0, imageWidthPx: 750, imageHeightPx: 1000 };
const crowd = { faceDetected: true, faceCount: 3, imageWidthPx: 750, imageHeightPx: 1000 };

describe('evaluateInputGate — live uploads are gated', () => {
  it('passes a single well-detected face', () => {
    expect(evaluateInputGate(faceOk, { isSample: false })).toBeNull();
  });

  it('rejects when no face is detected', () => {
    const g = evaluateInputGate(noFace, { isSample: false });
    expect(g?.reason).toBe('no-face');
    expect(g.message).toMatch(/No face found/);
    expect(g.message).toContain('750x1000');
  });

  it('rejects when multiple faces are detected', () => {
    const g = evaluateInputGate(crowd, { isSample: false });
    expect(g?.reason).toBe('multi-face');
    expect(g.message).toMatch(/single-person/);
    expect(g.message).toContain('3 people');
  });

  it('does not throw on malformed/missing metrics (treated as no-face)', () => {
    expect(evaluateInputGate(undefined, { isSample: false })?.reason).toBe('no-face');
    expect(evaluateInputGate({}, { isSample: false })?.reason).toBe('no-face');
  });
});

describe('evaluateInputGate — curated samples are never gated', () => {
  // Samples are pre-validated and ship with cached coaching that does not depend
  // on MediaPipe. A candid the model can't localize (e.g. a head-turn) must still
  // render its cached coaching rather than hit "No face found".
  it('passes a sample even when no face is detected', () => {
    expect(evaluateInputGate(noFace, { isSample: true })).toBeNull();
  });

  it('passes a sample even when multiple faces are detected', () => {
    expect(evaluateInputGate(crowd, { isSample: true })).toBeNull();
  });

  it('defaults isSample to false (gated) when options omitted', () => {
    expect(evaluateInputGate(noFace)?.reason).toBe('no-face');
  });
});
