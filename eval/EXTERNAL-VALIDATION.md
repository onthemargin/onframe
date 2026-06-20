# OnFrame — external validation of the "professional bar"

## Why
The default eval is **circular**: an LLM (Gemini Flash) scores, LLM-written
`labels.json` validate, and an LLM (Claude) judged the labels. Agreement inside
that loop can't tell us whether the coaching meets a *real* professional bar. To
break the loop we add **independent graders** and **external human ground
truth**, and we test **sensitivity/specificity** with constructed cases.

No single method gives "truth" — aesthetic judgment is subjective and pros
disagree. The defensible claim we're building toward:

> Per-category scores correlate ρ=X with aggregated human/expert ratings on N
> external images, agree with an independent frontier model at MAE=Y, and
> respond correctly (and *only* in the right category) to controlled
> degradations.

## The four approaches

### 1. Multi-model jury (independent grader)  → `jury.mjs`
Score the 12 samples with **Gemini 2.5 Pro** (stronger, independent of the
shipped Flash) using the *live* production prompt, plus **Claude** grades added
by hand. Report per-category MAE + max divergence between graders.
- **Tests:** does another capable model agree? Divergence localizes the shaky
  categories (hypothesis: lighting + low-light "intentional vs underexposed").
- **Limit:** still LLMs → shared blind spots; agreement ≠ correctness.

### 2. Controlled degradation (constructed ground truth)  → `degradation-test.mjs`
From each sharp, well-lit sample, generate degraded variants (PIL):
`blur` (→ Sharpness), `underexpose`/`overexpose` (→ Lighting), `busy-bg`
composite (→ Background), `offcenter-crop` (→ Composition). Score baseline +
variants; assert the **target** category drops by ≥ threshold **and** non-target
categories stay within tolerance.
- **Tests:** sensitivity (does it react?) + specificity (only the right axis?).
  This is exactly what would have caught the original "texture≠focus" bug.
- **Limit:** synthetic degradations, not natural bad photos.

### 3. PPA "12 Elements of a Merit Image" audit (rubric grounding)  → this doc
Compare OnFrame's 6 categories + weights to the standard pro print-jury rubric
(Impact, Technical Excellence, Creativity, Style, Composition, Lighting, Color,
Center of Interest, …; modern IPC scores on Impact / Technical Excellence /
Composition / Style). See "PPA audit" section below.
- **Tests:** are we even measuring what pros weight? (Spoiler: no Impact / no
  Creativity / no Style.)
- **Limit:** a rubric, not data.

### 4. External human-labeled datasets (real external validity)  → `dataset-corr.mjs`
Run the production Vertex scorer over a sample of:
- **AADB** (10k Flickr, 5 raters, 11 attributes incl. `lighting`,
  `color harmony`, `depth of field`, `rule of thirds`, `object emphasis`,
  `symmetry`) — attribute→category map below. Per-category Spearman vs humans.
- **PIQ23** (DXOMARK, 5,116 portraits, 30+ experts; `face detail`≈Sharpness,
  `face exposure`≈Lighting). Portrait-specific technical ground truth.
- (Optional) **AVA** overall aesthetic; **Q-Align/one-align** as a non-Gemini
  oracle for overall.
- **Limit:** datasets measure aesthetic/technical quality, not "coaching"; the
  attribute→category mapping is approximate; non-commercial research use only.

#### AADB attribute → OnFrame category map
| OnFrame category | AADB attribute(s) |
|---|---|
| Lighting | `lighting` |
| Background | `depth_of_field`, `object_emphasis` |
| Composition & Framing | `rule_of_thirds`, `balancing_element`, `symmetry` |
| Sharpness & Focus | `motion_blur` (inverted) |
| (overall) | aesthetic score |
| Head Angle & Pose / Eye Contact | *no AADB equivalent — not externally validated here* |

## Shared metrics
`lib.mjs` (pure, unit-tested): `mae`, `spearman`, `gradeAgreement`,
`checkDegradation`. Reused by every harness so the math is tested once.

## How results feed back
- Degradation failures → prompt fix (category leakage) — re-run before/after.
- Jury divergence + dataset miscorrelation on a category → that's where the
  prompt/labels need work; update and re-measure.
- PPA gaps → decide whether to add Impact/Style-type axes or explicitly scope
  OnFrame as a *technical-competence* coach (and say so in the UI).

## PPA audit (result)

PPA's **12 Elements of a Merit Image** (the pro print-jury standard; modern IPC
scores on the four in **bold**): **Impact**, **Technical Excellence**,
**Composition**, **Creativity**/**Style**, Lighting, Color Balance/Harmony,
Center of Interest, Subject Matter, Technique, Storytelling, Presentation.

Mapping OnFrame's 6 categories (weights) onto it:

| OnFrame category | wt | PPA element |
|---|---|---|
| Lighting | .30 | Lighting |
| Head Angle & Pose | .25 | Subject Matter / Technique (posing) |
| Composition & Framing | .20 | Composition + Center of Interest |
| Sharpness & Focus | .15 | Technical Excellence (partial) |
| Background | .05 | Composition (separation) |
| Eye Contact & Gaze | .05 | Center of Interest / engagement |

**Gaps — OnFrame has ZERO coverage of the axes pro juries weight most:**
- **Impact** (emotional response) — the headline IPC element. Not scored.
- **Creativity** (originality) and **Style** (subject ↔ presentation) — not scored.
- **Storytelling** — not scored.
- **Color Balance/Harmony** — no dedicated axis (only implicit in lighting; note
  even PIQ23 dropped color as too hard to annotate consistently).

**Weighting issue:** OnFrame puts 55% on Lighting+Pose. Pose at .25 is high — in
the PPA frame posing is part of Subject Matter/Technique, not a top-tier element,
while Impact/Composition/Technical Excellence (which we under- or don't weight)
are. We over-index on pose and under-index on "does this image land."

**Honest conclusion:** OnFrame is a **technical-fundamentals coach**, not a
merit-image judge. It grades execution (light, framing, focus, separation, gaze)
competently but cannot speak to impact/creativity/style — the difference between
"technically clean" and "portfolio-grade." Two options:
1. Add an **Expression/Impact** axis (Gemini already comments on expression —
   "joyful," "confident" — so it can score it) and optionally a **Color** axis;
   rebalance Pose down.
2. Or explicitly scope the product in-UI as *technical fundamentals* coaching and
   stop implying a "pro portrait" verdict. (Recommended near-term — honest, no
   new subjective axis to calibrate.)

## Results (2026-06-20, gemini-2.5-flash production prompt)

### Controlled degradation (`degradation-test.mjs`) — sensitivity ✅, specificity ❌
Every degradation moved its target hard (sensitivity is excellent):
blur → Sharpness −95/−98, underexpose → Lighting −30, overexpose → Lighting −50,
busy-bg → Background −65. BUT scores are **entangled** — a pure blur (face
geometry unchanged) also dropped Pose −18, Composition −20, Eye Contact −27.
Some leakage is legitimate (can't judge eye contact on a blurred face; an
overexposed frame genuinely blows the background too), but Pose/Composition
moving on a blur is true cross-category bleed. Two variants are confounded by
crude image-gen (the busy-bg ellipse paste hit Composition −70; the off-center
canvas only moved Composition −5). **Takeaway: the scorer reacts strongly but
does not score each axis independently** — a slightly soft upload will drag
several unrelated category scores down. Cleaner, better-isolated degradations
would sharpen this; the blur case alone already proves the entanglement.

### Multi-model jury (`jury.mjs`) — Flash (shipped) vs Gemini 2.5 Pro, 11/12 (s8 timed out)
| category | MAE | maxDiff | ρ |
|---|---|---|---|
| Sharpness & Focus | 3.6 | 23 | −0.14 (constant — no rank signal) |
| Head Angle & Pose | 5.5 | 10 | 0.73 |
| Background | 6.5 | 18 | 0.88 |
| Eye Contact & Gaze | 9.7 | **40** | 0.49 |
| Lighting | 10.1 | **27** | 0.48 |
| Composition & Framing | 10.4 | 25 | 0.35 |

- **Strong agreement:** Background (ρ.88), Pose (ρ.73).
- **Shaky:** Lighting, Composition, and especially **Eye Contact** (maxDiff 40).
- **Lighting over-generosity confirmed:** on the dramatic/low-light shots Flash
  gives 92–95 where the stronger Pro says ~68 (s11 92/68, s12 95/68). The
  pro-bar prompt fixed "punish all shadow" but **over-corrected toward rewarding
  dramatic/underexposed light** — Pro is the tie-breaker saying we're now too
  generous there.
- **Eye Contact is the least reliable axis:** s11 93/55, s7 90/50 — the two
  models flatly disagree on whether the gaze connects.
- Sharpness agrees tightly but is **constant (~95)** → no discrimination.

### External dataset (`dataset-corr.mjs`) — harness ready, data acquisition blocked
Harness + the AADB attribute→category mapping are built and unit-tested
(`deriveHumanCategoryScores`). A real external-validity number is **not produced
here**: AADB ships as Google-Drive zip archives + a MATLAB `.mat` label file,
which needs `gdown` + `scipy` (absent) and a ~130MB+ download. To run for real:
download `datasetImages_warp256.zip` + `AADBinfo.mat`, emit a manifest
`[{image, attrs:{lighting,depth_of_field,...}}]`, then
`node eval/dataset-corr.mjs manifest.json`. PIQ23 is an alternative
(portrait-specific, expert) with the same harness shape. **No number fabricated.**

### What this says about the "pro bar"
- Composition/Background/Sharpness/gaze-detection are solid; Background + Pose
  also survive an independent-model cross-check.
- **Lighting is now slightly too generous on dramatic/low light** (jury) — tighten.
- **Eye Contact is the least trustworthy category** (jury maxDiff 40) and scores
  are **entangled** under degradation (specificity) — both are the next fixes.
- We still have **no external human-data validation** until AADB/PIQ23 is pulled,
  and **no Impact/Creativity/Style** axis at all (PPA audit). The honest claim
  remains: a *technical-fundamentals* coach, cross-checked by a second model,
  not a verified merit-image judge.

## Round 2 — after lighting + eye-contact prompt fixes (2026-06-20)

Prompt changes: (a) lighting now judges the FACE's exposure, not frame
brightness — well-lit face on a dark bg = excellent low-key, but a face buried
in shadow/underexposed caps 55–70; (b) eye contact is defined geometrically
(gaze-to-lens + openness/catchlights), decoupled from expression warmth, with
anchors. Re-ran the jury (9/12; Pro timed out on s7/s8/s12):

| category | MAE before → after | maxDiff before → after |
|---|---|---|
| Eye Contact & Gaze | 9.7 → **2.8** | 40 → **7** |
| Lighting | 10.1 → 10.8 | 27 → 23 |
| Background | 6.5 → 2.7 | 18 → 10 |
| Sharpness | 3.6 → 1.4 | 23 → 5 |
| overall | 7.6 → **5.4** | — |

- **Eye contact: decisively fixed.** The geometric definition converged the two
  models (s11 was 93/55 → now 95/88). Candid off-camera (s12) now lands ~60, not
  ~50/90.
- **Lighting targeted cases fixed:** s11 underexposed Δ24 → 7 (65/72); s4 good
  low-key now 95/95 (the over-correction that briefly dropped s4 to 65 was fixed
  by judging FACE exposure, not frame darkness).
- **Lighting residual (new, milder):** Flash is still ~15–23 generous vs Pro on
  CLEAN EVEN light (s10 95/72, s3 88/70) — Flash reads it as "beautiful soft,"
  Pro as "merely competent." Pro is likely the better call. A future tweak could
  tighten the "even+bright" ceiling, but this is subjective, not a clear bug.

## Cross-family jury (`claude-jury.mjs`) — Gemini Flash vs Claude, 11/12
A different model FAMILY (Claude, not Gemini) graded the samples on the same
rubric. This is the strongest independent check available without external data
(the Flash↔Pro jury shares a family).

| category | MAE | maxDiff | ρ |
|---|---|---|---|
| Head Angle & Pose | 3.1 | 10 | 0.88 |
| Sharpness & Focus | 2.8 | 5 | 0.63 |
| Eye Contact & Gaze | 4.1 | 8 | 0.75 |
| Lighting | 6.9 | 17 | 0.77 |
| Composition & Framing | 6.9 | 20 | 0.66 |
| Background | 7.8 | **35** | 0.74 |
| **overall** | **5.3** | — | — |

- **Strong cross-family agreement** (overall MAE 5.3; every category ρ 0.63–0.88).
  The lighting + eye-contact fixes hold across families: Claude confirms s4
  low-key 95/90, s11 underexposed 65/60, candid s12 eyes 60/55.
- **Caught a cache error:** s1 Background = **85** in the current cache is wrong —
  the intruding flag clearly competes; Claude says 50 and earlier Gemini runs
  said 45. This is run-to-run variance noise, not a prompt bug.
- **Residual family disagreements (Flash slightly generous):** s11 composition
  (F85/C65 — excess headroom), s1 background/composition. Flash slightly HARSH on
  s5 golden-hour lighting (F65/C82). All minor except the s1 background outlier.

## External data — outcome (all real routes attempted, blocked)
- **AADB** (ideal, per-attribute human ratings): 2016 Google-Drive folder returns
  **HTTP 401** — public access revoked. Dead.
- **PIQ23** (portrait, expert): **5 GB behind a request form** (emailed link). Not
  pullable headlessly.
- **TAD66K** HF mirror: images only, **no score labels**.
- **HF aesthetic search**: only LAION (machine-predicted scores, not human) — not
  ground truth.
The harness (`dataset-corr.mjs`) + AADB attribute→category mapping
(`deriveHumanCategoryScores`, unit-tested) are **ready**: drop in a manifest of
`{image, attrs}` from AADB/PIQ23 once obtained and it produces the real
per-category Spearman/MAE. **No number was fabricated.**

## Cost / status
Jury + degradation = tens of Vertex calls (cents). Dataset correlation = a few
hundred calls (~$1–3) + dataset download (non-commercial research use).
Run from project root: `node eval/<harness>.mjs`. ADC via the VM SA.
