import { describe, it, expect } from 'vitest';

import { mergeCoachingResult } from '../merge.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLocalResult() {
  return {
    cards: [
      { category: 'Lighting',              score: 70, title: 'Local light', tip: 'local tip',  priority: 2, gearNeeded: [] },
      { category: 'Head Angle & Pose',     score: 75, title: 'Local pose',  tip: 'local tip',  priority: 2, gearNeeded: [] },
      { category: 'Composition & Framing', score: 80, title: 'Local frame', tip: 'local tip',  priority: 3, gearNeeded: [] },
      { category: 'Sharpness & Focus',     score: 77, title: 'Local sharp', tip: 'local tip',  priority: 3, gearNeeded: [] },
      { category: 'Background',            score: 60, title: 'Local bg',    tip: 'local tip',  priority: 2, gearNeeded: [] },
      { category: 'Eye Contact & Gaze',    score: 72, title: 'Local eyes',  tip: 'local tip',  priority: 2, gearNeeded: [] },
    ],
    overallScore: 73,
    photoType: { type: 'head-and-shoulders', label: 'Head & shoulders' },
    summary: 'Local summary.',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mergeCoachingResult', () => {
  it('uses cloud cards + overallScore and annotates each with localScore when cloud has a full result', () => {
    const local = makeLocalResult();
    const cloud = {
      aiSummary: 'great expression',
      cards: [
        { category: 'Lighting',              score: 64, title: 'Cloud light', tip: 'tip', priority: 2, gearNeeded: [], aiReason: 'Reads flat.' },
        { category: 'Head Angle & Pose',     score: 75, title: 'Cloud pose',  tip: 'tip', priority: 2, gearNeeded: [] },
        { category: 'Composition & Framing', score: 75, title: 'Cloud frame', tip: 'tip', priority: 2, gearNeeded: [], aiReason: 'Centered.' },
        { category: 'Sharpness & Focus',     score: 77, title: 'Cloud sharp', tip: 'tip', priority: 3, gearNeeded: [] },
        { category: 'Background',            score: 56, title: 'Cloud bg',    tip: 'tip', priority: 1, gearNeeded: [], aiReason: 'Busy.' },
        { category: 'Eye Contact & Gaze',    score: 77, title: 'Cloud eyes',  tip: 'tip', priority: 2, gearNeeded: [], aiReason: 'Engaged.' },
      ],
      overallScore: 70,
    };

    const merged = mergeCoachingResult(local, cloud);

    expect(merged.overallScore).toBe(70);
    expect(merged.aiSummary).toBe('great expression');
    expect(merged.aiUnavailable).toBeFalsy();
    expect(merged.cards).toHaveLength(6);

    // Each card has the localScore annotated from the matching local category
    const lighting = merged.cards.find((c) => c.category === 'Lighting');
    expect(lighting.score).toBe(64);
    expect(lighting.localScore).toBe(70);
    expect(lighting.aiReason).toBe('Reads flat.');

    const eye = merged.cards.find((c) => c.category === 'Eye Contact & Gaze');
    expect(eye.score).toBe(77);
    expect(eye.localScore).toBe(72);

    // Photo type and other top-level fields are preserved from the local result
    expect(merged.photoType).toEqual(local.photoType);
  });

  it('keeps local cards and attaches cloud aiSummary when cloud has aiSummary only', () => {
    const local = makeLocalResult();
    const cloud = { aiSummary: 'just words' };

    const merged = mergeCoachingResult(local, cloud);

    expect(merged.cards).toEqual(local.cards);
    expect(merged.overallScore).toBe(local.overallScore);
    expect(merged.aiSummary).toBe('just words');
    expect(merged.aiUnavailable).toBeFalsy();
  });

  it('keeps local cards and sets aiUnavailable when cloud signals unavailable', () => {
    const local = makeLocalResult();
    const cloud = { aiUnavailable: true };

    const merged = mergeCoachingResult(local, cloud);

    expect(merged.cards).toEqual(local.cards);
    expect(merged.overallScore).toBe(local.overallScore);
    expect(merged.aiUnavailable).toBe(true);
    expect(merged.aiSummary).toBeUndefined();
  });

  it('falls back to local result when cloud response is missing', () => {
    const local = makeLocalResult();

    const merged = mergeCoachingResult(local, null);

    expect(merged.cards).toEqual(local.cards);
    expect(merged.overallScore).toBe(local.overallScore);
    expect(merged.aiSummary).toBeUndefined();
    expect(merged.aiUnavailable).toBeFalsy();
  });

  it('ignores empty/whitespace aiSummary so the UI does not render a blank summary', () => {
    const local = makeLocalResult();
    const cloud = { aiSummary: '   ' };

    const merged = mergeCoachingResult(local, cloud);

    expect(merged.aiSummary).toBeUndefined();
  });

  it('falls back to local cards when cloud has cards but no overallScore (incomplete)', () => {
    const local = makeLocalResult();
    const cloud = {
      cards: [{ category: 'Lighting', score: 50, title: 't', tip: 't', priority: 1, gearNeeded: [] }],
      // overallScore intentionally missing
      aiSummary: 'partial',
    };

    const merged = mergeCoachingResult(local, cloud);

    expect(merged.cards).toEqual(local.cards);
    expect(merged.overallScore).toBe(local.overallScore);
    expect(merged.aiSummary).toBe('partial');
  });

  it('still sets localScore to undefined when no local card matches a cloud category', () => {
    const local = makeLocalResult();
    const cloud = {
      aiSummary: 'ok',
      overallScore: 65,
      cards: [
        { category: 'NewCategory', score: 50, title: 't', tip: 't', priority: 2, gearNeeded: [], aiReason: 'r' },
      ],
    };

    const merged = mergeCoachingResult(local, cloud);

    expect(merged.cards).toHaveLength(1);
    expect(merged.cards[0].localScore).toBeUndefined();
  });
});
