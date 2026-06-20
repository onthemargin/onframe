/**
 * sampleCoaching.js — cached cloud coaching for the built-in sample photos.
 *
 * The 12 sample images never change, so their Vertex coaching is pulled once
 * (eval/gen-sample-cache.mjs → sampleCoaching.data.json) and served from cache.
 * Only user-uploaded photos — genuinely new data — call Vertex at runtime.
 *
 * `lookupCoaching` is kept free of the JSON import so it's unit-testable; the
 * generated data is wired in by the caller (app.js).
 */

// Returns the cached cloud result ({ aiSummary, cards, overallScore }) for a
// known sample filename, or null for anything else — uploads, unknown names,
// or a malformed cache entry. Uses hasOwnProperty so prototype keys
// ("toString", etc.) never accidentally match.
export function lookupCoaching(cache, filename) {
  if (!cache || typeof cache !== 'object') return null;
  if (typeof filename !== 'string' || !filename) return null;
  if (!Object.prototype.hasOwnProperty.call(cache, filename)) return null;
  const entry = cache[filename];
  if (!entry || !Array.isArray(entry.cards) || entry.cards.length === 0) return null;
  if (!entry.cards.every((c) => c && typeof c.category === 'string' && typeof c.score === 'number')) return null;
  if (typeof entry.overallScore !== 'number') return null;
  return entry;
}
