#!/usr/bin/env node
// onframe/eval/degradation-test.mjs
//
// Controlled-degradation specificity test (constructed ground truth).
// Generates degraded variants of sample portraits (each targeting ONE category),
// scores them with the LIVE production prompt, and checks that the target score
// drops (sensitivity) while the other categories hold (specificity).
//
//   node eval/degradation-test.mjs
//
// Costs ~9 Vertex calls. ADC via the VM SA.

import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { checkDegradation } from './lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dirname, '..', 'web-server', 'package.json'));
const { createVertexClient } = require(resolve(__dirname, '..', 'web-server', 'vertex.js'));
const { normalizeAiResponse } = require(resolve(__dirname, '..', 'web-server', 'server.js'));

const METRICS_TEXT = JSON.stringify({ summary: 'Degradation-test portrait.' });
const client = createVertexClient({ project: 'your-gcp-project', location: 'us-central1', model: 'gemini-2.5-flash' });

async function scoreFile(path) {
  const result = await client.analyze({ photoBuffer: readFileSync(path), metricsText: METRICS_TEXT, photoMimeType: 'image/jpeg' });
  const norm = normalizeAiResponse({ cards: result.cards, aiSummary: result.aiSummary });
  return Object.fromEntries(norm.cards.map((c) => [c.category, c.score]));
}

async function main() {
  const outDir = mkdtempSync(join(tmpdir(), 'onframe-degrade-'));
  const manifestRaw = execFileSync('python3', [join(__dirname, 'gen-degraded.py'), outDir], { encoding: 'utf8' });
  const manifest = JSON.parse(manifestRaw);

  // Score baselines once.
  const baseScores = {};
  for (const base of manifest.baselines) {
    baseScores[`base_${base}`] = await scoreFile(join(outDir, `base_${base}`));
  }

  console.log('Controlled degradation — target should DROP, others should HOLD (tolerance ±12):\n');
  const SHORT = { 'Lighting': 'Light', 'Head Angle & Pose': 'Pose', 'Composition & Framing': 'Comp', 'Sharpness & Focus': 'Sharp', 'Background': 'Bg', 'Eye Contact & Gaze': 'Eyes' };
  let pass = 0;
  for (const v of manifest.variants) {
    const degraded = await scoreFile(join(outDir, v.file));
    const baseline = baseScores[v.base];
    const r = checkDegradation(baseline, degraded, { target: v.target, direction: v.direction, minDelta: 12, tolerance: 12 });
    if (r.pass) pass++;
    const deltas = Object.keys(baseline).map((c) => `${SHORT[c]}:${(degraded[c] - baseline[c] >= 0 ? '+' : '') + (degraded[c] - baseline[c])}`).join(' ');
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${v.label.padEnd(20)} target=${SHORT[v.target]} Δ${r.targetDelta >= 0 ? '+' : ''}${r.targetDelta}`);
    console.log(`      deltas: ${deltas}`);
    if (!r.pass) console.log(`      ↳ ${r.reason}`);
  }
  console.log(`\n${pass}/${manifest.variants.length} degradations behaved correctly (sensitive + specific).`);
  return pass === manifest.variants.length ? 0 : 1;
}

main().then((c) => process.exit(c)).catch((e) => { console.error('FATAL:', e?.stack || e); process.exit(1); });
