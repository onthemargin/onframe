import { describe, it, expect } from 'vitest';
import { mae, spearman, gradeAgreement, checkDegradation, deriveHumanCategoryScores, medianCards } from '../lib.mjs';

describe('mae', () => {
  it('averages absolute differences over finite pairs', () => {
    expect(mae([10, 20, 30], [12, 18, 30])).toBeCloseTo((2 + 2 + 0) / 3, 5);
  });
  it('ignores pairs with non-finite values', () => {
    expect(mae([10, null, 30], [12, 99, 33])).toBeCloseTo((2 + 3) / 2, 5);
  });
});

describe('spearman', () => {
  it('is +1 for identical rank order', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 5);
  });
  it('is -1 for reversed rank order', () => {
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 5);
  });
});

describe('gradeAgreement', () => {
  const cats = ['Lighting', 'Sharpness & Focus'];
  const A = [
    { 'Lighting': 80, 'Sharpness & Focus': 90 },
    { 'Lighting': 60, 'Sharpness & Focus': 95 },
  ];
  const B = [
    { 'Lighting': 70, 'Sharpness & Focus': 92 },
    { 'Lighting': 65, 'Sharpness & Focus': 95 },
  ];
  it('computes per-category MAE and max divergence between two graders', () => {
    const out = gradeAgreement(A, B, cats);
    expect(out.byCategory['Lighting'].mae).toBeCloseTo((10 + 5) / 2, 5);
    expect(out.byCategory['Lighting'].maxDiff).toBe(10);
    expect(out.byCategory['Sharpness & Focus'].mae).toBeCloseTo((2 + 0) / 2, 5);
    expect(out.byCategory['Sharpness & Focus'].maxDiff).toBe(2);
  });
  it('reports an overall MAE across all categories', () => {
    const out = gradeAgreement(A, B, cats);
    expect(out.overallMae).toBeCloseTo((10 + 5 + 2 + 0) / 4, 5);
  });
});

describe('checkDegradation', () => {
  const baseline = { 'Lighting': 85, 'Sharpness & Focus': 95, 'Background': 90 };

  it('passes when the target category drops enough and others hold', () => {
    const degraded = { 'Lighting': 85, 'Sharpness & Focus': 55, 'Background': 88 };
    const r = checkDegradation(baseline, degraded, { target: 'Sharpness & Focus', minDelta: 15, tolerance: 8 });
    expect(r.pass).toBe(true);
    expect(r.targetDelta).toBe(-40);
    expect(r.collateral).toHaveLength(0);
  });

  it('fails when the target category does not move enough (insensitive)', () => {
    const degraded = { 'Lighting': 85, 'Sharpness & Focus': 90, 'Background': 90 };
    const r = checkDegradation(baseline, degraded, { target: 'Sharpness & Focus', minDelta: 15 });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/did not drop/i);
  });

  it('fails when a non-target category leaks beyond tolerance (non-specific)', () => {
    const degraded = { 'Lighting': 60, 'Sharpness & Focus': 55, 'Background': 90 };
    const r = checkDegradation(baseline, degraded, { target: 'Sharpness & Focus', minDelta: 15, tolerance: 8 });
    expect(r.pass).toBe(false);
    expect(r.collateral.map((c) => c.category)).toContain('Lighting');
  });

  it('supports an upward expectation (e.g. fixing a fault raises the score)', () => {
    const improved = { 'Lighting': 95, 'Sharpness & Focus': 95, 'Background': 90 };
    const r = checkDegradation(baseline, improved, { target: 'Lighting', direction: 'up', minDelta: 8 });
    expect(r.pass).toBe(true);
    expect(r.targetDelta).toBe(10);
  });
});

describe('medianCards (variance-killer for the sample cache)', () => {
  // 3 runs of the same sample; each run is an array of category cards.
  const mk = (cat, score, tip) => ({ category: cat, score, tip });
  const runs = [
    [mk('Lighting', 60, 'a'), mk('Background', 90, 'x')],
    [mk('Lighting', 80, 'b'), mk('Background', 70, 'y')],
    [mk('Lighting', 70, 'c'), mk('Background', 50, 'z')],
  ];

  it('returns the per-category MEDIAN score across runs', () => {
    const out = medianCards(runs);
    const byCat = Object.fromEntries(out.map((c) => [c.category, c.score]));
    expect(byCat['Lighting']).toBe(70);    // median of 60,80,70
    expect(byCat['Background']).toBe(70);  // median of 90,70,50
  });

  it('keeps the TIP from the run that produced the median score (tip matches score)', () => {
    const out = medianCards(runs);
    const lighting = out.find((c) => c.category === 'Lighting');
    expect(lighting.tip).toBe('c');        // run 3 had Lighting 70 (the median)
    const bg = out.find((c) => c.category === 'Background');
    expect(bg.tip).toBe('y');              // run 2 had Background 70 (the median)
  });

  it('handles a single run (returns it unchanged)', () => {
    const out = medianCards([[mk('Lighting', 42, 'solo')]]);
    expect(out).toEqual([mk('Lighting', 42, 'solo')]);
  });
});

describe('deriveHumanCategoryScores (AADB attrs → OnFrame categories, 0–100)', () => {
  it('maps the lighting attribute linearly from -1..1 to 0..100', () => {
    expect(deriveHumanCategoryScores({ lighting: 1 })['Lighting']).toBe(100);
    expect(deriveHumanCategoryScores({ lighting: -1 })['Lighting']).toBe(0);
    expect(deriveHumanCategoryScores({ lighting: 0 })['Lighting']).toBe(50);
  });
  it('inverts motion_blur into Sharpness (more blur => lower sharpness)', () => {
    expect(deriveHumanCategoryScores({ motion_blur: 1 })['Sharpness & Focus']).toBe(0);
    expect(deriveHumanCategoryScores({ motion_blur: -1 })['Sharpness & Focus']).toBe(100);
  });
  it('averages multiple attributes for Composition and Background', () => {
    const out = deriveHumanCategoryScores({ rule_of_thirds: 1, balancing_element: 0, symmetry: -1, depth_of_field: 1, object_emphasis: 0 });
    expect(out['Composition & Framing']).toBeCloseTo((100 + 50 + 0) / 3, 5);
    expect(out['Background']).toBeCloseTo((100 + 50) / 2, 5);
  });
  it('returns null for categories with no contributing attribute present', () => {
    const out = deriveHumanCategoryScores({ lighting: 0.5 });
    expect(out['Composition & Framing']).toBeNull();
    expect(out['Head Angle & Pose']).toBeNull();   // no AADB equivalent — never validated
    expect(out['Expression & Mood']).toBeNull();
  });
});
