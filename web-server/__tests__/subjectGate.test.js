import { describe, it, expect } from 'vitest';
import { parseVertexOutput } from '../vertex.js';
import { subjectRejection } from '../server.js';

const scores = {
  lighting: { score: 80, tip: 'x' }, headpose: { score: 80, tip: 'x' },
  composition: { score: 80, tip: 'x' }, sharpness: { score: 80, tip: 'x' },
  background: { score: 80, tip: 'x' }, expression: { score: 80, tip: 'x' },
};
const base = { aiSummary: 'A portrait.', scores };

describe('parseVertexOutput — subject classification', () => {
  it('returns the subject when valid', () => {
    expect(parseVertexOutput(JSON.stringify({ ...base, subject: 'multiple_people' })).subject).toBe('multiple_people');
    expect(parseVertexOutput(JSON.stringify({ ...base, subject: 'not_a_person' })).subject).toBe('not_a_person');
    expect(parseVertexOutput(JSON.stringify({ ...base, subject: 'single_person' })).subject).toBe('single_person');
  });

  it('fails OPEN to single_person when subject is missing or invalid (never wrongly reject a real portrait)', () => {
    expect(parseVertexOutput(JSON.stringify(base)).subject).toBe('single_person');
    expect(parseVertexOutput(JSON.stringify({ ...base, subject: 'weird' })).subject).toBe('single_person');
  });
});

describe('subjectRejection — deny coaching on non-single-person photos', () => {
  it('passes a single person (or missing) through', () => {
    expect(subjectRejection('single_person')).toBeNull();
    expect(subjectRejection(undefined)).toBeNull();
  });

  it('rejects multiple people with a clear message', () => {
    const r = subjectRejection('multiple_people');
    expect(r.rejected).toBe(true);
    expect(r.message).toMatch(/one person|solo|single/i);
  });

  it('rejects non-person subjects (animals, objects, scenes)', () => {
    const r = subjectRejection('not_a_person');
    expect(r.rejected).toBe(true);
    expect(r.message).toMatch(/person|portrait/i);
  });
});
