import { describe, it, expect } from 'vitest';
import { lookupCoaching } from '../sampleCoaching.js';

const CACHE = {
  'sample1.jpg': {
    aiSummary: 'Looks good.',
    overallScore: 80,
    cards: [{ category: 'Lighting', score: 80, tip: 'x', priority: 3 }],
  },
};

describe('lookupCoaching', () => {
  it('returns the cached coaching for a known sample filename', () => {
    const out = lookupCoaching(CACHE, 'sample1.jpg');
    expect(out).toBe(CACHE['sample1.jpg']);
    expect(out.cards.length).toBeGreaterThan(0);
    expect(typeof out.overallScore).toBe('number');
  });

  it('returns null for an unknown / uploaded filename', () => {
    expect(lookupCoaching(CACHE, 'my-vacation-pic.jpg')).toBeNull();
    expect(lookupCoaching(CACHE, 'sample99.jpg')).toBeNull();
  });

  it('returns null for non-string filename or missing cache', () => {
    expect(lookupCoaching(CACHE, null)).toBeNull();
    expect(lookupCoaching(CACHE, '')).toBeNull();
    expect(lookupCoaching(null, 'sample1.jpg')).toBeNull();
  });

  it('returns null for a malformed cache entry (no usable cards)', () => {
    expect(lookupCoaching({ 'sampleX.jpg': { overallScore: 5 } }, 'sampleX.jpg')).toBeNull();
    expect(lookupCoaching({ 'sampleX.jpg': { cards: [], overallScore: 5 } }, 'sampleX.jpg')).toBeNull();
    expect(lookupCoaching({ 'sampleX.jpg': { cards: [{}] } }, 'sampleX.jpg')).toBeNull();
  });

  it('does not match inherited Object.prototype keys', () => {
    expect(lookupCoaching(CACHE, 'toString')).toBeNull();
    expect(lookupCoaching(CACHE, 'hasOwnProperty')).toBeNull();
  });
});
