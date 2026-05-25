# OnFrame Vertex AI Gemini eval harness

A self-contained local script for evaluating the quality and determinism of the
production Vertex AI Gemini prompt used in OnFrame photo coaching.

This directory is **not** part of the production build. It is never copied into
the Docker image, never deployed, and never imported from `web/`, `web-server/`,
or `deploy/`. The harness duplicates the production `SYSTEM_PROMPT` verbatim so
it keeps measuring the prompt currently in production even if the script is run
months from now — review `eval.mjs` if `web-server/vertex.js` changes and the
two should drift back into sync.

## What it does

Two modes:

1. **Quality (default)** — for each sample listed in `labels.json`, calls Vertex
   once with the production prompt, compares predicted per-category delta
   against the labeled expected delta, and prints:
     - per-sample table of predicted (`.p`) vs labeled (`.l`) deltas
     - per-category MAE (mean absolute error) and Spearman rank correlation
     - a summary line: `MAE avg: X.XX, ρ avg: 0.XXX`
     - a one-line `aiSummary` preview per sample

2. **Determinism** — runs the same sample 5 times in parallel and reports the
   per-category mean and stddev across those 5 runs. Any category whose stddev
   exceeds 2 is flagged `WARN` so you can spot prompts that are noisy.

## Run it

```
# from anywhere
node /home/swaroop_krishnamurthy/app.gyatso.me/onframe/eval/eval.mjs
node /home/swaroop_krishnamurthy/app.gyatso.me/onframe/eval/eval.mjs -d sample5
node /home/swaroop_krishnamurthy/app.gyatso.me/onframe/eval/eval.mjs -h
```

The script uses **Application Default Credentials** (the cloudbuild-deploy SA
on this VM, which has `roles/editor` and therefore Vertex access). No env vars
are required.

A full quality run = 12 Vertex calls. A determinism run = 5 Vertex calls. Each
includes one base64-encoded portrait image, so each run **costs a few cents on
the `ai-dev-463705` GCP project**. Don't loop on it.

## Updating labels

`labels.json` is the human-labeled expected delta per sample.

**The current labels are starter placeholders** written by an AI based on a
visual scan of the sample images — they are not authoritative ground truth.
Skim them, adjust per-category deltas to match your own portrait-photo
intuition, and re-run the harness.

Schema per entry:

```json
"sample1.jpg": {
  "note": "one-line description of the photo",
  "expected": {
    "lighting":    { "delta":  -2 },
    "composition": { "delta":  -3 },
    "background":  { "delta":  -5 },
    "eyecontact":  { "delta":   4 },
    "headpose":    { "delta":   1 }
  }
}
```

Delta range:
- `lighting`, `composition`, `background`, `eyecontact`: integer `-10..10`
- `headpose`: integer `-5..5`
- `0` means "on par with baseline". Positive = above baseline, negative = below.

Reasonable labeling heuristic: imagine the average iPhone snapshot a friend
takes; that's roughly zero on every axis. Studio-quality work earns +3 to +5,
serious problems earn -3 to -5, and the extremes (`+8`/`+10` or `-8`/`-10`)
should be rare.

## Files

```
eval/
  eval.mjs       harness script (ESM, Node 20+)
  labels.json    expected deltas per sample (12 entries)
  README.md      this file
```

## Interpreting results

- **MAE** = average absolute distance between predicted and labeled delta. Lower
  is better. With deltas in `-10..10`, a MAE of `~3` means Gemini is typically
  within 3 points of the human label — not bad. MAE of `~6+` means Gemini and
  the human are largely talking past each other on that category.
- **Spearman ρ** = rank correlation between predicted and labeled across the 12
  samples. `+1` = Gemini and the human rank the samples identically on that
  axis. `0` = no relationship. Negative = Gemini ranks them in roughly the
  opposite order from the human — that's the signal a category is broken.
- **Determinism stddev** = how much the same photo's per-category delta jitters
  across repeated calls at `temperature=0.3`. Anything above `~2` is loud
  enough that A/B comparisons across prompt versions will be hard to read.

## Hard rules

- No edits to `web/`, `web-server/`, or `deploy/` (production code).
- No deploys, no `git push`, no `/go`.
- Don't bundle this directory into the Cloud Run image.
- Don't change the harness prompt to "improve" results — the whole point is to
  evaluate the prompt that's actually shipping.
