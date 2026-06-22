import { describe, it, expect } from 'vitest';
import { summarizeCardScores } from '../server.js';

describe('summarizeCardScores — per-category scores for analyze logs', () => {
  const cards = [
    { category: 'Expression & Mood', score: 85 },
    { category: 'Lighting', score: 55 },
    { category: 'Sharpness & Focus', score: 90 },
    { category: 'Composition & Framing', score: 85 },
    { category: 'Background', score: 60 },
    { category: 'Head Angle & Pose', score: 80 },
  ];

  it('maps each category to a short, queryable key', () => {
    expect(summarizeCardScores(cards)).toEqual({
      expression: 85, lighting: 55, sharpness: 90,
      composition: 85, background: 60, headpose: 80,
    });
  });

  it('rounds scores and tolerates missing / malformed cards', () => {
    expect(summarizeCardScores([
      { category: 'Lighting', score: 54.6 }, null, {}, { score: 5 },
    ])).toEqual({ lighting: 55 });
  });

  it('returns {} for empty or invalid input', () => {
    expect(summarizeCardScores(null)).toEqual({});
    expect(summarizeCardScores([])).toEqual({});
  });
});
