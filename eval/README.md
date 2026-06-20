# OnFrame Vertex AI Gemini eval harness

A self-contained local script for evaluating the quality and determinism of the
production Vertex AI Gemini prompt used in OnFrame photo coaching.

This directory is **not** part of the production build. It is never copied into
the Docker image, never deployed, and is never imported *by* `web/`,
`web-server/`, or `deploy/`. It does, however, `require()` the production
`buildPrompt`/`SYSTEM_PROMPT` from `web-server/vertex.js` (one-way, eval → prod)
so the harness always evaluates exactly the prompt that ships — there is no
hand-copied duplicate to drift out of sync.

## What it does

Two modes:

1. **Quality (default)** — for each sample listed in `labels.json`, calls Vertex
   once with the production prompt, compares the predicted per-category
   **absolute 0–100 score** against the labeled expected score, and prints:
     - per-sample table of predicted (`.p`) vs labeled (`.l`) scores
     - per-category MAE (mean absolute error) and Spearman rank correlation
     - a summary line: `MAE avg: X.XX, ρ avg: 0.XXX`
     - a one-line `aiSummary` preview per sample

   The six categories scored are `lighting`, `headpose`, `composition`,
   `sharpness`, `background`, `eyecontact`. Under cloud-primary scoring Gemini
   owns **all six** (including sharpness — local heuristics no longer score it).

2. **Determinism** — runs the same sample 5 times in parallel and reports the
   per-category mean and stddev across those 5 runs. Any category whose stddev
   exceeds 2 is flagged `WARN` so you can spot prompts that are noisy.

## Run it

```
# from the onframe repo root
VERTEX_PROJECT=<your-gcp-project> node eval/eval.mjs
VERTEX_PROJECT=<your-gcp-project> node eval/eval.mjs -d sample5
node eval/eval.mjs -h
```

Set `VERTEX_PROJECT` (or `GOOGLE_CLOUD_PROJECT`) to a GCP project with Vertex AI
enabled, and have **Application Default Credentials** available (a service
account or user with `roles/aiplatform.user`). No other env vars are required.

A full quality run = 12 Vertex calls. A determinism run = 5 Vertex calls. Each
includes one base64-encoded portrait image, so each run **costs a few cents** on
your GCP project. Don't loop on it.

## Updating labels

`labels.json` is the AI-labeled expected **absolute 0–100 score** per sample
(was relative deltas before the cloud-primary rewrite).

**The current labels are starter placeholders** written by an AI based on a
visual scan of the sample images — they are not authoritative ground truth.
Skim them, adjust per-category scores to match your own portrait-photo
intuition, and re-run the harness.

Schema per entry (all six categories, each `{ score, reason }`):

```json
"sample1.jpg": {
  "note": "one-line description of the photo",
  "expected": {
    "lighting":    { "score": 70, "reason": "..." },
    "headpose":    { "score": 76, "reason": "..." },
    "composition": { "score": 72, "reason": "..." },
    "sharpness":   { "score": 85, "reason": "..." },
    "background":  { "score": 58, "reason": "..." },
    "eyecontact":  { "score": 81, "reason": "..." }
  }
}
```

Score band (matches the production prompt rubric):
- `90–100` exceptional · `75–89` strong · `60–74` acceptable ·
  `40–59` a problem a viewer registers · `0–39` serious issue.
- An average iPhone snapshot lands in the 60s on most axes.

## Files

```
eval/
  eval.mjs              harness script (ESM, Node 20+)
  gen-sample-cache.mjs  one-time pull → web/sampleCoaching.data.json (re-run after prompt changes)
  labels.json           expected absolute scores per sample (12 entries)
  README.md             this file
```

## Interpreting results

- **MAE** = average absolute distance between predicted and labeled score (both
  `0..100`). Lower is better. A MAE of `~5` means Gemini is typically within 5
  points of the label. Note scores cluster in a fairly narrow band (most decent
  portraits land 70–95), so MAE matters more than raw rank here.
- **Spearman ρ** = rank correlation between predicted and labeled across the 12
  samples. `+1` = Gemini and the human rank the samples identically on that
  axis. `0` = no relationship. Negative = opposite order — the signal a
  category is broken. (With N=12 and compressed scores, ρ is noisy; read it as
  directional, not precise.)
- **Determinism stddev** = how much the same photo's per-category score jitters
  across repeated calls at `temperature=0.1, seed=1`. Anything above `~2` is
  loud enough that A/B comparisons across prompt versions will be hard to read.

## Hard rules

- No edits to `web/`, `web-server/`, or `deploy/` (production code).
- No deploys, no `git push`, no `/go`.
- Don't bundle this directory into the Cloud Run image.
- Don't change the harness prompt to "improve" results — the whole point is to
  evaluate the prompt that's actually shipping.
