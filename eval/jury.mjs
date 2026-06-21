#!/usr/bin/env node
// onframe/eval/jury.mjs
//
// Independent-grader jury: score the 12 samples with Gemini 2.5 PRO (stronger,
// independent of the shipped Flash) using the LIVE production prompt, and
// measure agreement with the production Flash scores (from the shipped cache).
// High MAE / maxDiff localizes the categories where a second capable model
// disagrees with what we ship.
//
//   node eval/jury.mjs
//
// Costs ~12 Vertex (Pro) calls. ADC via the VM SA.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { gradeAgreement } from './lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dirname, '..', 'web-server', 'package.json'));
const { createVertexClient } = require(resolve(__dirname, '..', 'web-server', 'vertex.js'));
const { normalizeAiResponse } = require(resolve(__dirname, '..', 'web-server', 'server.js'));

const CATS = ['Lighting', 'Head Angle & Pose', 'Composition & Framing', 'Sharpness & Focus', 'Background', 'Expression & Mood'];
const SHORT = { 'Lighting': 'Light', 'Head Angle & Pose': 'Pose', 'Composition & Framing': 'Comp', 'Sharpness & Focus': 'Sharp', 'Background': 'Bg', 'Expression & Mood': 'Eyes' };
const SAMPLE_DIR = resolve(__dirname, '..', 'web', 'sample');
const CACHE = JSON.parse(readFileSync(resolve(__dirname, '..', 'web', 'sampleCoaching.data.json'), 'utf8'));
const METRICS_TEXT = JSON.stringify({ summary: 'Sample portrait (cached coaching).' });
const PRO_MODEL = process.argv[2] || 'gemini-2.5-pro';

const PROJECT = process.env.VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
if (!PROJECT) { console.error('Set VERTEX_PROJECT (or GOOGLE_CLOUD_PROJECT) to your GCP project id.'); process.exit(2); }
const pro = createVertexClient({ project: PROJECT, location: 'us-central1', model: PRO_MODEL });

function cardsToRow(cards) { return Object.fromEntries(cards.map((c) => [c.category, c.score])); }

async function main() {
  const samples = readdirSync(SAMPLE_DIR).filter((f) => /^sample\d+\.jpg$/.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));

  console.log(`Jury: production Flash (cached) vs independent ${PRO_MODEL}\n`);
  async function scoreProWithRetry(path, tries = 2) {
    for (let i = 0; i < tries; i++) {
      try {
        const result = await pro.analyze({ photoBuffer: readFileSync(path), metricsText: METRICS_TEXT, photoMimeType: 'image/jpeg' });
        return normalizeAiResponse({ cards: result.cards, aiSummary: result.aiSummary });
      } catch (err) {
        if (i === tries - 1) return null;
      }
    }
  }

  const flashRows = [], proRows = [], skipped = [];
  for (const s of samples) {
    const flash = cardsToRow(CACHE[s].cards);
    const norm = await scoreProWithRetry(join(SAMPLE_DIR, s));
    if (!norm) { skipped.push(s); console.log(`${s.padEnd(13)} (F/P)  [Pro unavailable — skipped]`); continue; }
    const proRow = cardsToRow(norm.cards);
    flashRows.push(flash); proRows.push(proRow);
    const line = CATS.map((c) => `${SHORT[c]} ${flash[c]}/${proRow[c]}`).join('  ');
    console.log(`${s.padEnd(13)} (F/P)  ${line}`);
  }
  if (skipped.length) console.log(`\n(${skipped.length} skipped: ${skipped.join(', ')})`);

  const ag = gradeAgreement(flashRows, proRows, CATS);
  console.log('\nPer-category Flash↔Pro agreement (lower MAE / maxDiff = more agreement):');
  console.log('  category                MAE   maxDiff   rho');
  for (const c of CATS) {
    const b = ag.byCategory[c];
    console.log(`  ${c.padEnd(22)} ${b.mae.toFixed(1).padStart(4)}   ${String(b.maxDiff).padStart(5)}    ${Number.isFinite(b.rho) ? b.rho.toFixed(2) : 'n/a'}`);
  }
  console.log(`\n  overall MAE: ${ag.overallMae.toFixed(1)}`);
}

main().catch((e) => { console.error('FATAL:', e?.stack || e); process.exit(1); });
