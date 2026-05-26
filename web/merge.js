/**
 * merge.js — pure helper for combining the local synthesizer result with
 * the cloud (Vertex AI) response from `/api/analyze`.
 *
 * The cloud response can take three shapes:
 *   1. Full result:  { aiSummary, cards: [...6], overallScore }
 *      → use the cloud cards + overallScore; annotate each card with the
 *        matching local card's `localScore` so the UI can render the delta.
 *   2. Summary only: { aiSummary }
 *      → keep local cards/overallScore; attach `aiSummary` for display.
 *   3. Unavailable:  { aiUnavailable: true }
 *      → keep local cards/overallScore; flag the degraded banner.
 *
 * Anything malformed/missing degrades gracefully to the local result.
 */

function hasNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasFullCloudResult(cloud) {
  return (
    cloud &&
    Array.isArray(cloud.cards) &&
    cloud.cards.length > 0 &&
    typeof cloud.overallScore === 'number' &&
    Number.isFinite(cloud.overallScore)
  );
}

function annotateWithLocalScores(cloudCards, localCards) {
  const localByCategory = new Map();
  for (const card of localCards || []) {
    if (card && typeof card.category === 'string') {
      localByCategory.set(card.category, card);
    }
  }
  return cloudCards.map((cloudCard) => {
    const localMatch = localByCategory.get(cloudCard?.category);
    return {
      ...cloudCard,
      localScore: localMatch ? localMatch.score : undefined,
    };
  });
}

export function mergeCoachingResult(localResult, cloudResponse) {
  const base = { ...localResult };
  // Always preserve original local cards for delta lookup downstream if needed.
  base.localCards = localResult?.cards || [];

  if (!cloudResponse || typeof cloudResponse !== 'object') {
    return base;
  }

  // Correlation id + timestamp flow through every cloud response shape
  // (success, summary-only, aiUnavailable). UI uses them for the trace tag.
  if (hasNonEmptyString(cloudResponse.id)) base.id = cloudResponse.id;
  if (hasNonEmptyString(cloudResponse.ts)) base.ts = cloudResponse.ts;

  if (cloudResponse.aiUnavailable) {
    base.aiUnavailable = true;
    return base;
  }

  if (hasNonEmptyString(cloudResponse.aiSummary)) {
    base.aiSummary = cloudResponse.aiSummary;
  }

  if (hasFullCloudResult(cloudResponse)) {
    base.cards = annotateWithLocalScores(cloudResponse.cards, localResult?.cards);
    base.overallScore = cloudResponse.overallScore;
  }

  return base;
}
