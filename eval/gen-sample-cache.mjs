#!/usr/bin/env node
// onframe/eval/gen-sample-cache.mjs
//
// ONE-TIME (re-runnable) generator for the sample-photo coaching cache.
//
// The 12 built-in sample photos never change, so there's no reason to spend a
// live Vertex call every time a visitor taps one. This script pulls the
// cloud-primary coaching ONCE per sample and writes it to
//   web/sampleCoaching.data.json
// which the app serves directly for samples. Only genuinely new (user-uploaded)
// photos hit Vertex at runtime.
//
// Re-run after changing the Vertex prompt/schema:
//   node eval/gen-sample-cache.mjs
//
// Uses the SAME production code paths (web-server/vertex.js +
// server.js#normalizeAiResponse) so the cached shape matches a live response.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { medianCards } from './lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dirname, '..', 'web-server', 'package.json'));

const { createVertexClient } = require(resolve(__dirname, '..', 'web-server', 'vertex.js'));
const { normalizeAiResponse, computeOverallScore } = require(resolve(__dirname, '..', 'web-server', 'server.js'));

const RUNS = Number(process.env.CACHE_RUNS) || 3; // median-of-N kills run-to-run variance

const PROJECT = process.env.VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
if (!PROJECT) { console.error('Set VERTEX_PROJECT (or GOOGLE_CLOUD_PROJECT) to your GCP project id.'); process.exit(2); }
const LOCATION = 'us-central1';
const MODEL = 'gemini-2.5-flash';
const SAMPLE_DIR = resolve(__dirname, '..', 'web', 'sample');
const OUT_PATH = resolve(__dirname, '..', 'web', 'sampleCoaching.data.json');

// Minimal grounding payload. Samples have no live MediaPipe geometry available
// headlessly; the cloud-primary prompt scores perceptually from the image, so a
// generic summary is sufficient for a fixed, cached result.
const METRICS_TEXT = JSON.stringify({ summary: 'Sample portrait (cached coaching).' });

async function main() {
  const samples = readdirSync(SAMPLE_DIR).filter((f) => /^sample\d+\.jpg$/.test(f)).sort(
    (a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10)
  );
  console.log(`Generating coaching cache for ${samples.length} samples → ${OUT_PATH}\n`);

  const client = createVertexClient({ project: PROJECT, location: LOCATION, model: MODEL });
  const out = {};

  // Median-of-N fires 3x per sample; back off on 429 / transient errors.
  async function analyzeWithRetry(args, tries = 5) {
    let delay = 3000;
    for (let i = 0; i < tries; i++) {
      try {
        const r = await client.analyze(args);
        if (!Array.isArray(r.cards) || !r.cards.length) throw new Error('no cards returned');
        return r;
      } catch (err) {
        if (i === tries - 1) throw err;
        await new Promise((res) => setTimeout(res, delay));
        delay *= 2;
      }
    }
  }

  for (const file of samples) {
    const photoBuffer = readFileSync(join(SAMPLE_DIR, file));
    try {
      // Run N times and take the per-category median so one noisy draw can't ship.
      const runs = [];
      for (let i = 0; i < RUNS; i++) {
        const result = await analyzeWithRetry({ photoBuffer, metricsText: METRICS_TEXT, photoMimeType: 'image/jpeg' });
        runs.push(normalizeAiResponse({ cards: result.cards, aiSummary: result.aiSummary }));
        await new Promise((res) => setTimeout(res, 800)); // gentle pacing between calls
      }
      const cards = medianCards(runs.map((r) => r.cards));
      const overallScore = computeOverallScore(cards);
      // aiSummary from the run whose overall is the median (representative).
      const byOverall = [...runs].sort((a, b) => a.overallScore - b.overallScore);
      const aiSummary = byOverall[Math.floor((byOverall.length - 1) / 2)].aiSummary;
      out[file] = { aiSummary, cards, overallScore };
      const spread = runs.map((r) => r.overallScore).sort((a, b) => a - b);
      console.log(`  ${file.padEnd(14)} overall=${overallScore} (runs ${spread.join('/')})  "${aiSummary.slice(0, 50)}"`);
    } catch (err) {
      console.error(`  ${file.padEnd(14)} FAILED: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }

  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nWrote ${Object.keys(out).length} entries to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('FATAL:', err?.stack || err?.message || err);
  process.exit(1);
});
