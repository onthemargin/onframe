#!/usr/bin/env node
// onframe/eval/claude-jury.mjs
//
// CROSS-FAMILY juror: Claude (a different model family from Gemini) grades the
// 12 samples on the production rubric, independently of the shipped Gemini Flash
// scores. The Flash↔Pro jury only compares Gemini-to-Gemini (shared blind
// spots); this adds a genuinely different grader. Claude grades are entered by
// hand (vision review on 2026-06-20) and compared to web/sampleCoaching.data.json.
//
//   node eval/claude-jury.mjs

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeAgreement } from './lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE = JSON.parse(readFileSync(resolve(__dirname, '..', 'web', 'sampleCoaching.data.json'), 'utf8'));
const CATS = ['Lighting', 'Head Angle & Pose', 'Composition & Framing', 'Sharpness & Focus', 'Background', 'Eye Contact & Gaze'];
const SHORT = { 'Lighting': 'Light', 'Head Angle & Pose': 'Pose', 'Composition & Framing': 'Comp', 'Sharpness & Focus': 'Sharp', 'Background': 'Bg', 'Eye Contact & Gaze': 'Eyes' };

// Claude's independent grades [Light, Pose, Comp, Sharp, Bg, Eyes]:
const CLAUDE = {
  'sample1.jpg':  [68, 78, 65, 90, 50, 90],
  'sample2.jpg':  [85, 78, 70, 95, 70, 92],
  'sample3.jpg':  [78, 70, 78, 95, 80, 92],
  'sample4.jpg':  [90, 70, 85, 95, 95, 92],
  'sample5.jpg':  [82, 85, 78, 92, 92, 82],
  'sample6.jpg':  [75, 82, 85, 95, 88, 92],
  'sample7.jpg':  [60, 68, 55, 92, 68, 88],
  'sample8.jpg':  [60, 75, 80, 92, 85, 90],
  'sample10.jpg': [88, 88, 80, 95, 82, 95],
  'sample11.jpg': [60, 82, 65, 90, 82, 88],
  'sample12.jpg': [82, 88, 65, 92, 65, 55],
};

const toRow = (arr) => Object.fromEntries(CATS.map((c, i) => [c, arr[i]]));
const samples = Object.keys(CLAUDE);
const claudeRows = samples.map((s) => toRow(CLAUDE[s]));
const flashRows = samples.map((s) => Object.fromEntries(CACHE[s].cards.map((c) => [c.category, c.score])));

console.log('Cross-family jury: shipped Gemini Flash (F) vs independent Claude (C)\n');
for (let i = 0; i < samples.length; i++) {
  const f = flashRows[i], c = claudeRows[i];
  console.log(`${samples[i].padEnd(13)} (F/C)  ${CATS.map((cat) => `${SHORT[cat]} ${f[cat]}/${c[cat]}`).join('  ')}`);
}

const ag = gradeAgreement(flashRows, claudeRows, CATS);
console.log('\nPer-category Gemini↔Claude agreement:');
console.log('  category                MAE   maxDiff   rho');
for (const cat of CATS) {
  const b = ag.byCategory[cat];
  console.log(`  ${cat.padEnd(22)} ${b.mae.toFixed(1).padStart(4)}   ${String(b.maxDiff).padStart(5)}    ${Number.isFinite(b.rho) ? b.rho.toFixed(2) : 'n/a'}`);
}
console.log(`\n  overall MAE: ${ag.overallMae.toFixed(1)}  (n=${samples.length}, s9 omitted — not graded)`);
