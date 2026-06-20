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

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dirname, '..', 'web-server', 'package.json'));

const { createVertexClient } = require(resolve(__dirname, '..', 'web-server', 'vertex.js'));
const { normalizeAiResponse } = require(resolve(__dirname, '..', 'web-server', 'server.js'));

const PROJECT = 'your-gcp-project';
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

  for (const file of samples) {
    const photoBuffer = readFileSync(join(SAMPLE_DIR, file));
    try {
      const result = await client.analyze({ photoBuffer, metricsText: METRICS_TEXT, photoMimeType: 'image/jpeg' });
      if (!Array.isArray(result.cards) || !result.cards.length) {
        throw new Error('no cards returned');
      }
      const normalized = normalizeAiResponse({ cards: result.cards, aiSummary: result.aiSummary });
      out[file] = {
        aiSummary: normalized.aiSummary,
        cards: normalized.cards,
        overallScore: normalized.overallScore,
      };
      console.log(`  ${file.padEnd(14)} overall=${normalized.overallScore}  "${normalized.aiSummary.slice(0, 60)}"`);
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
