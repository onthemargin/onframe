#!/usr/bin/env node
// onframe/eval/dataset-corr.mjs
//
// External-validity test: correlate OnFrame's per-category Vertex scores against
// REAL human attribute ratings from a public dataset (AADB-style).
//
// This is the only harness that needs an external download — it does not ship
// images. Provide a manifest JSON:
//   [ { "image": "/abs/path/to/img.jpg",
//       "attrs": { "lighting": 0.4, "depth_of_field": 0.8, "rule_of_thirds": 0.2,
//                  "balancing_element": 0.1, "symmetry": -0.3, "object_emphasis": 0.6,
//                  "motion_blur": -0.9 } },   // AADB attrs, each averaged over raters in [-1,1]
//     ... ]
// then:  node eval/dataset-corr.mjs <manifest.json>
//
// AADB: https://github.com/aimerykong/deepImageAestheticsAnalysis (images + attribute MOS).
// PIQ23: https://github.com/DXOMARK-Research/PIQ2023 (portrait, expert; map face-detail→Sharpness, face-exposure→Lighting).
//
// Reports per-category Spearman ρ + MAE between model scores and human-derived
// category scores. Pose / Expression have no AADB equivalent and are skipped.

import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spearman, mae, deriveHumanCategoryScores } from './lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dirname, '..', 'web-server', 'package.json'));
const { createVertexClient } = require(resolve(__dirname, '..', 'web-server', 'vertex.js'));
const { normalizeAiResponse } = require(resolve(__dirname, '..', 'web-server', 'server.js'));

const CATS = ['Lighting', 'Background', 'Composition & Framing', 'Sharpness & Focus'];
const METRICS_TEXT = JSON.stringify({ summary: 'External dataset image.' });
const PROJECT = process.env.VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
if (!PROJECT) { console.error('Set VERTEX_PROJECT (or GOOGLE_CLOUD_PROJECT) to your GCP project id.'); process.exit(2); }
const client = createVertexClient({ project: PROJECT, location: 'us-central1', model: 'gemini-2.5-flash' });

async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    console.error('usage: node eval/dataset-corr.mjs <manifest.json>  (see header for format / dataset sources)');
    process.exit(2);
  }
  const items = JSON.parse(readFileSync(manifestPath, 'utf8'));
  console.log(`Correlating OnFrame scores vs human ratings on ${items.length} images...\n`);

  const modelByCat = Object.fromEntries(CATS.map((c) => [c, []]));
  const humanByCat = Object.fromEntries(CATS.map((c) => [c, []]));

  for (const [i, item] of items.entries()) {
    let modelRow;
    try {
      const r = await client.analyze({ photoBuffer: readFileSync(item.image), metricsText: METRICS_TEXT, photoMimeType: 'image/jpeg' });
      modelRow = Object.fromEntries(normalizeAiResponse({ cards: r.cards, aiSummary: r.aiSummary }).cards.map((c) => [c.category, c.score]));
    } catch (err) {
      console.error(`  [${i}] ${item.image}: scoring failed (${err.message}) — skipped`);
      continue;
    }
    const human = deriveHumanCategoryScores(item.attrs || {});
    for (const c of CATS) {
      if (Number.isFinite(modelRow[c]) && Number.isFinite(human[c])) {
        modelByCat[c].push(modelRow[c]);
        humanByCat[c].push(human[c]);
      }
    }
  }

  console.log('Per-category: OnFrame (Vertex) vs human attribute ratings:');
  console.log('  category                 n    rho     MAE');
  for (const c of CATS) {
    const n = modelByCat[c].length;
    const rho = spearman(modelByCat[c], humanByCat[c]);
    const m = mae(modelByCat[c], humanByCat[c]);
    console.log(`  ${c.padEnd(22)} ${String(n).padStart(4)}  ${Number.isFinite(rho) ? rho.toFixed(2).padStart(5) : '  n/a'}  ${Number.isFinite(m) ? m.toFixed(1).padStart(6) : '   n/a'}`);
  }
}

main().catch((e) => { console.error('FATAL:', e?.stack || e); process.exit(1); });
