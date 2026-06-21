# OnFrame scoring — rubric, validation & known issues

Living doc for how OnFrame scores portraits, how the rubric is grounded, how it's
validated, and what's still imperfect. Last updated 2026-06-21.

## How scoring works now (cloud-primary)
Gemini 2.5 Flash on Vertex AI scores all **6 categories 0–100** directly from the
photo (incl. Sharpness). The local MediaPipe/canvas synthesizer is only a
fallback (Vertex down) + the overlay-pin geometry provider. Weighted overall:
Lighting .30 · Head Angle & Pose .25 · Composition .20 · Sharpness .15 ·
Background .05 · Eye Contact .05. Response shape: `{aiSummary, scores:{<6
keys>:{score,tip}}}` (`web-server/vertex.js`).

Sample photos use a pre-pulled cache (`web/sampleCoaching.data.json`); only user
uploads hit Vertex live. Uploads are downscaled to 1536px (`web/downscale.js`).

## The rubric is web-grounded (not intuition)
Lighting and composition were the model's weakest, most self-inconsistent axes,
so the prompt rules are grounded in professional photography sources:
- **Lighting** (SLR Lounge, Studio Q, The Lens Lounge, Sandra Coan, PPA): directional
  light SCULPTS — a soft shaped shadow is a strength, never "underexposed";
  flat/beauty light is flattering but 2D (ordinary flat ~70–75, genuinely
  beautiful soft beauty light 85–88); low-key needs a deliberate KEY on a
  *properly-exposed* face (a dim/dusk face that's just dark = 60–72, not low-key);
  reward catchlights; faults = buried detail, blown highlights, muddy skin cast,
  monster (under) lighting.
- **Composition** (Photography Mad, Houston Photowalks, Corel): eyes on the upper
  third = well-framed; excess headroom is only a fault when the eyes fall below
  mid-frame; judge by the single most salient framing issue, don't default to one.
- **Background** (Photography Mad): judge by COMPETITION for attention, not
  "relevance" — a fitting-but-distracting element (a flag) still scores low.

If you change the lighting rules, **re-run the jury + degradation — don't eyeball it.**

## Validation harnesses (`eval/`, not shipped in the image)
| Script | What it checks |
|---|---|
| `eval.mjs` | predicted vs `labels.json` absolute scores (MAE/Spearman). Imports the live prompt from `vertex.js` — no duplicate to drift. |
| `jury.mjs` | Flash (shipped cache) vs an independent **Gemini 2.5 Pro** grader. Same model family. |
| `claude-jury.mjs` | Flash vs **Claude** — a different model FAMILY (strongest in-house cross-check). |
| `degradation-test.mjs` | constructed ground truth — blur/under/over-expose/busy-bg variants must move the target category and (ideally) only it. |
| `dataset-corr.mjs` | external human ratings (AADB/PIQ23) → real per-category Spearman. **Built + unit-tested, not yet run** (data access blocked, see below). |
| `gen-sample-cache.mjs` | regenerates the cache; **median-of-3** per category (`lib.mjs#medianCards`) to kill run-to-run variance; retries on 429. |
| `lib.mjs` (+ `__tests__`) | shared, unit-tested math: mae, spearman, gradeAgreement, checkDegradation, medianCards, deriveHumanCategoryScores. |

Run any with `VERTEX_PROJECT=<proj> node eval/<script>.mjs`. ADC required.

## Validation results (current)
- **Cross-model agreement on Lighting: MAE 10.8 → 4.3, maxDiff 27 → 10** after the
  web-grounded rewrite. Lighting was the worst category; two independent models
  now agree on it tightly. Background MAE ~5; Sharpness/Eyes tight.
- **Cross-family (Claude) jury:** overall MAE ~5; confirms the Sharpness and
  eye-contact fixes hold across model families.
- **Degradation:** sensitivity is excellent (blur → Sharp −90; underexpose →
  Light −35, so the scale still discriminates at the low end). Specificity is
  weak — a global degradation (blur) bleeds into several categories
  (entanglement); a known, un-fixed limitation. Two of six variants are crude
  image-gen artifacts (busy-bg ellipse, weak off-center).
- **Variance:** median-of-3 makes every sample regenerate identically (XX/XX/XX).

## Per-sample status (2026-06-21)
8/12 are accurate. Known imperfections:
- **s10 (laughing red) is under-rated (~83).** Its light is genuinely flat daylight
  (Lighting ~80); what makes it the best image is the *expression*, which we
  don't score. Needs an Impact/Expression axis — a product decision, not tuning.
- **s7 (off-center) & s8 (blue gel) are genuinely ambiguous** — Gemini Pro
  disagrees with Flash by 20–27 pts on their composition/lighting. Not
  prompt-fixable; the images are debatable.
- s11 (dusk suit) over-rating was fixed (Lighting 88 → 65 via the low-key/exposure
  boundary), resolving the s10↔s11 ranking inversion.

## Open items / honest gaps
1. **No Impact/Creativity/Style axis** (PPA audit). OnFrame is a *technical-
   fundamentals* coach, not a merit-image judge — this caps how "right" scores
   like s10 can be. Add an Expression axis or scope the product as fundamentals.
2. **No external human-data validation yet.** AADB's Google-Drive folder is dead
   (401); PIQ23 is 5 GB behind an institutional request form
   (corp.dxomark.com/data-base-piq23). `dataset-corr.mjs` is ready — drop in a
   manifest of `{image, attrs}` and it produces the real number.
3. **Category entanglement** — scores aren't fully independent under degradation.
4. **s8-type ambiguity** — creative gel reads as "stylized" or "unflattering cast"
   inconsistently across runs; inherently subjective.

## PPA "12 Elements" audit (reference)
Modern IPC juries score on Impact, Technical Excellence, Composition, Style.
OnFrame covers technical/framing/focus/gaze well but has **zero** coverage of
Impact, Creativity, Style, or Storytelling — the axes that separate "technically
clean" from "portfolio-grade." That's the deliberate scope boundary.
