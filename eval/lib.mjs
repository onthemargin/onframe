// onframe/eval/lib.mjs
//
// Pure, unit-tested helpers shared by the eval harnesses (eval.mjs, jury.mjs,
// degradation-test.mjs, dataset-corr.mjs). No I/O, no Vertex — just math so the
// statistics are tested once and reused everywhere.

export function mean(arr) {
  const xs = arr.filter((x) => Number.isFinite(x));
  if (!xs.length) return NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function stddev(arr) {
  const xs = arr.filter((x) => Number.isFinite(x));
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

export function mae(predicted, expected) {
  const pairs = predicted
    .map((p, i) => [p, expected[i]])
    .filter(([p, e]) => Number.isFinite(p) && Number.isFinite(e));
  if (!pairs.length) return NaN;
  return pairs.reduce((acc, [p, e]) => acc + Math.abs(p - e), 0) / pairs.length;
}

// Spearman rank correlation, average ranks for ties.
export function spearman(a, b) {
  const pairs = a
    .map((x, i) => [x, b[i]])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const n = pairs.length;
  if (n < 2) return NaN;
  const ranks = (vals) => {
    const indexed = vals.map((v, i) => [v, i]);
    indexed.sort((p, q) => p[0] - q[0]);
    const r = new Array(vals.length);
    let i = 0;
    while (i < indexed.length) {
      let j = i;
      while (j + 1 < indexed.length && indexed[j + 1][0] === indexed[i][0]) j++;
      const avgRank = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[indexed[k][1]] = avgRank;
      i = j + 1;
    }
    return r;
  };
  const ax = pairs.map((p) => p[0]);
  const bx = pairs.map((p) => p[1]);
  const ra = ranks(ax);
  const rb = ranks(bx);
  const mra = mean(ra);
  const mrb = mean(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = ra[i] - mra;
    const y = rb[i] - mrb;
    num += x * y; da += x * x; db += y * y;
  }
  if (da === 0 || db === 0) return NaN;
  return num / Math.sqrt(da * db);
}

// Agreement between two graders. rowsA/rowsB are aligned arrays of per-sample
// objects { category: score }. Returns per-category MAE + max divergence and an
// overall MAE — high MAE / maxDiff localizes the categories where graders (e.g.
// production Flash vs an independent Pro/Claude) disagree.
export function gradeAgreement(rowsA, rowsB, categories) {
  const byCategory = {};
  const allDiffs = [];
  for (const cat of categories) {
    const a = rowsA.map((r) => r?.[cat]);
    const b = rowsB.map((r) => r?.[cat]);
    const diffs = a
      .map((x, i) => [x, b[i]])
      .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
      .map(([x, y]) => Math.abs(x - y));
    byCategory[cat] = {
      mae: mae(a, b),
      maxDiff: diffs.length ? Math.max(...diffs) : NaN,
      rho: spearman(a, b),
      n: diffs.length,
    };
    allDiffs.push(...diffs);
  }
  return {
    byCategory,
    overallMae: allDiffs.length ? allDiffs.reduce((s, d) => s + d, 0) / allDiffs.length : NaN,
  };
}

// Collapse N runs of the same image into one variance-resistant card set.
// `runs` is an array of card-arrays (each card { category, score, tip, ... }).
// For each category, returns the card holding the MEDIAN score across runs — so
// the score AND its tip come from the same (median) run, and a single noisy draw
// can't ship. Lower-median for even N.
export function medianCards(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return [];
  const categories = runs[0].map((c) => c.category);
  return categories.map((cat) => {
    const cards = runs.map((r) => r.find((c) => c.category === cat)).filter(Boolean);
    const sorted = [...cards].sort((a, b) => a.score - b.score);
    return sorted[Math.floor((sorted.length - 1) / 2)];
  });
}

// Map AADB human attribute ratings (each in [-1, 1], the averaged per-image
// "contribution to aesthetics") onto OnFrame's category scale [0, 100], so we
// can correlate the model's per-category scores against real human ratings.
// motion_blur is inverted (more blur → lower sharpness). Categories with no
// contributing attribute present return null (excluded from correlation).
// Pose / Eye Contact have no AADB equivalent and are always null here.
const AADB_CATEGORY_MAP = {
  'Lighting': [['lighting', false]],
  'Background': [['depth_of_field', false], ['object_emphasis', false]],
  'Composition & Framing': [['rule_of_thirds', false], ['balancing_element', false], ['symmetry', false]],
  'Sharpness & Focus': [['motion_blur', true]],
  'Head Angle & Pose': [],
  'Eye Contact & Gaze': [],
};

export function deriveHumanCategoryScores(attrs) {
  const to100 = (v) => Math.max(0, Math.min(100, ((v + 1) / 2) * 100));
  const out = {};
  for (const [category, specs] of Object.entries(AADB_CATEGORY_MAP)) {
    const vals = [];
    for (const [attr, invert] of specs) {
      if (attrs && Number.isFinite(attrs[attr])) {
        const mapped = to100(attrs[attr]);
        vals.push(invert ? 100 - mapped : mapped);
      }
    }
    out[category] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  return out;
}

// Constructed-ground-truth check for one degraded variant.
// baseline/degraded: { category: score }. expectation:
//   { target, direction='down', minDelta=10, tolerance=8 }
// Pass iff the TARGET category moved >= minDelta in `direction` (sensitivity)
// AND no non-target category moved more than tolerance (specificity).
export function checkDegradation(baseline, degraded, { target, direction = 'down', minDelta = 10, tolerance = 8 } = {}) {
  const delta = (degraded?.[target] ?? NaN) - (baseline?.[target] ?? NaN);
  const movedEnough = direction === 'up' ? delta >= minDelta : delta <= -minDelta;

  const collateral = [];
  for (const cat of Object.keys(baseline)) {
    if (cat === target) continue;
    const d = (degraded?.[cat] ?? NaN) - (baseline?.[cat] ?? NaN);
    if (Number.isFinite(d) && Math.abs(d) > tolerance) {
      collateral.push({ category: cat, delta: d });
    }
  }

  const reasons = [];
  if (!movedEnough) {
    reasons.push(`target ${target} did not drop enough (Δ=${Number.isFinite(delta) ? delta : 'n/a'}, need ${direction === 'up' ? '+' : '-'}${minDelta})`);
  }
  if (collateral.length) {
    reasons.push(`leakage into ${collateral.map((c) => `${c.category}(${c.delta > 0 ? '+' : ''}${c.delta})`).join(', ')}`);
  }
  return {
    pass: movedEnough && collateral.length === 0,
    targetDelta: delta,
    collateral,
    reason: reasons.join('; '),
  };
}
