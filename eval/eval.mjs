#!/usr/bin/env node
// onframe/eval/eval.mjs
//
// Evaluation harness for OnFrame's Vertex AI Gemini prompt quality.
//
// Two modes:
//   node eval.mjs                       quality vs labels (all samples in labels.json)
//   node eval.mjs -d sample5.jpg        determinism check (5 runs, one sample)
//   node eval.mjs -h                    help
//
// Calls Vertex directly using Application Default Credentials (needs a project
// with Vertex AI enabled and a principal with roles/aiplatform.user). Local-only
// script — does NOT touch web/ or web-server/. Each full run costs a few cents.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mean, stddev, mae, spearman } from './lib.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Use createRequire so we can load the CJS google-auth-library that lives under
// web-server/node_modules without disturbing that tree.
const require = createRequire(
  join(__dirname, '..', 'web-server', 'package.json')
);
const { GoogleAuth } = require('google-auth-library');
// Import the LIVE production prompt + builder so the harness always evaluates
// exactly what ships (no hand-copied duplicate to drift out of sync).
const { buildPrompt } = require(resolve(__dirname, '..', 'web-server', 'vertex.js'));

// ---------- config ----------

const PROJECT = process.env.VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
if (!PROJECT) { console.error('Set VERTEX_PROJECT (or GOOGLE_CLOUD_PROJECT) to your GCP project id.'); process.exit(2); }
const LOCATION = 'us-central1';
const MODEL = 'gemini-2.5-flash';
const VERTEX_URL = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;

const SAMPLE_DIR = resolve(__dirname, '..', 'web', 'sample');
const LABELS_PATH = resolve(__dirname, 'labels.json');

const CATEGORIES = ['lighting', 'headpose', 'composition', 'sharpness', 'background', 'expression'];

// Grounding metrics payload sent for every photo. Under cloud-primary scoring
// Vertex returns *absolute* 0–100 scores judged from the image; this payload is
// just stable, realistic-looking geometry/grounding input (no live MediaPipe
// here). Weights match the production scoring categories (see plan.md).
const BASELINE_METRICS = JSON.stringify({
  summary: 'Portrait analysis (eval harness baseline).',
  photoType: 'head-and-shoulders',
  localScores: {
    lighting: 70,
    headpose: 75,
    composition: 80,
    sharpness: 75,
    background: 65,
    expression: 75,
  },
  localCards: [
    { category: 'Lighting',              score: 70, weight: 0.30, title: 'Baseline', tip: 'x', priority: 2, gearNeeded: [] },
    { category: 'Head Angle & Pose',     score: 75, weight: 0.25, title: 'Baseline', tip: 'x', priority: 2, gearNeeded: [] },
    { category: 'Composition & Framing', score: 80, weight: 0.20, title: 'Baseline', tip: 'x', priority: 2, gearNeeded: [] },
    { category: 'Sharpness & Focus',     score: 75, weight: 0.15, title: 'Baseline', tip: 'x', priority: 2, gearNeeded: [] },
    { category: 'Background',            score: 65, weight: 0.05, title: 'Baseline', tip: 'x', priority: 2, gearNeeded: [] },
    { category: 'Expression & Mood',    score: 75, weight: 0.05, title: 'Baseline', tip: 'x', priority: 2, gearNeeded: [] },
  ],
});

// ---------- vertex client ----------

// Same safety belt as production vertex.js: Gemini occasionally emits "+3"
// (explicit sign) inside JSON, which is not valid JSON. Strip leading +
// after a JSON-position marker so JSON.parse succeeds.
function stripPlusSignedIntegers(text) {
  return text.replace(/([:\[,\s])\+(\d)/g, '$1$2');
}

async function getAccessToken() {
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const tok = await client.getAccessToken();
  const token = typeof tok === 'string' ? tok : tok?.token;
  if (!token) throw new Error('Failed to obtain Vertex AI access token');
  return token;
}

async function callVertex({ token, photoBuffer, metricsText }) {
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: buildPrompt(metricsText) },
          { inlineData: { mimeType: 'image/jpeg', data: photoBuffer.toString('base64') } },
        ],
      },
    ],
    generationConfig: {
      // Mirror production vertex.js: near-deterministic, full output budget.
      temperature: 0.1,
      seed: 1,
      maxOutputTokens: 4096,
      topP: 0.95,
      responseMimeType: 'application/json',
    },
  };

  const response = await fetch(VERTEX_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Vertex ${response.status}: ${text.slice(0, 300)}`);
  }

  const json = await response.json();
  const text = json?.candidates?.[0]?.content?.parts?.map((p) => p?.text || '').join('') || '';
  if (!text.trim()) throw new Error('Vertex returned empty content');
  const cleaned = stripPlusSignedIntegers(text);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Vertex output not valid JSON: ${err.message}`);
  }
  return parsed;
}

function readPhoto(sampleFile) {
  const p = join(SAMPLE_DIR, sampleFile);
  if (!existsSync(p)) throw new Error(`sample not found: ${p}`);
  return readFileSync(p);
}

function extractScores(parsed) {
  const out = {};
  const s = parsed?.scores || {};
  for (const cat of CATEGORIES) {
    const v = s[cat]?.score;
    out[cat] = Number.isFinite(v) ? v : null;
  }
  return out;
}

// ---------- stats (shared, unit-tested in eval/__tests__/lib.test.mjs) ----------

// ---------- table formatting ----------

function fmt(n, width = 5, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a'.padStart(width);
  if (Number.isInteger(n) && digits === 0) return String(n).padStart(width);
  return n.toFixed(digits).padStart(width);
}

function table(rows, headers) {
  // rows = array of arrays of strings; headers = array of strings.
  const cols = headers.length;
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const sep = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
  const fmtRow = (r) => '| ' + r.map((c, i) => String(c ?? '').padEnd(widths[i])).join(' | ') + ' |';
  const lines = [sep, fmtRow(headers), sep];
  for (const r of rows) lines.push(fmtRow(r));
  lines.push(sep);
  return lines.join('\n');
}

// ---------- modes ----------

async function modeQuality(token) {
  const labels = JSON.parse(readFileSync(LABELS_PATH, 'utf8'));
  const samples = Object.keys(labels).filter((k) => !k.startsWith('_'));

  console.log(`Running quality eval on ${samples.length} samples (parallel)...\n`);

  const t0 = Date.now();
  const results = await Promise.all(
    samples.map(async (sample) => {
      try {
        const photo = readPhoto(sample);
        const parsed = await callVertex({ token, photoBuffer: photo, metricsText: BASELINE_METRICS });
        const predicted = extractScores(parsed);
        const expected = {};
        for (const cat of CATEGORIES) expected[cat] = labels[sample].expected?.[cat]?.score ?? null;
        return { sample, predicted, expected, aiSummary: parsed?.aiSummary || '', ok: true };
      } catch (err) {
        return { sample, error: err.message, ok: false };
      }
    })
  );
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  // Per-sample table
  const headers = ['sample', ...CATEGORIES.flatMap((c) => [`${c}.p`, `${c}.l`])];
  const rows = [];
  for (const r of results) {
    if (!r.ok) {
      rows.push([r.sample, ...Array(CATEGORIES.length * 2).fill('ERR')]);
      continue;
    }
    const row = [r.sample];
    for (const cat of CATEGORIES) {
      row.push(fmt(r.predicted[cat], 4, 0).trim());
      row.push(fmt(r.expected[cat], 4, 0).trim());
    }
    rows.push(row);
  }
  console.log('Per-sample predicted (.p) vs labeled (.l) scores:');
  console.log(table(rows, headers));

  // Errors
  const errors = results.filter((r) => !r.ok);
  if (errors.length) {
    console.log(`\n${errors.length} sample(s) failed:`);
    for (const e of errors) console.log(`  ${e.sample}: ${e.error}`);
  }

  // Per-category MAE + Spearman
  const okResults = results.filter((r) => r.ok);
  const statsRows = [];
  const maes = [];
  const rhos = [];
  for (const cat of CATEGORIES) {
    const pred = okResults.map((r) => r.predicted[cat]);
    const exp = okResults.map((r) => r.expected[cat]);
    const m = mae(pred, exp);
    const rho = spearman(pred, exp);
    if (Number.isFinite(m)) maes.push(m);
    if (Number.isFinite(rho)) rhos.push(rho);
    statsRows.push([cat, fmt(m, 5, 2).trim(), fmt(rho, 6, 3).trim(), String(pred.filter(Number.isFinite).length)]);
  }
  console.log('\nPer-category quality:');
  console.log(table(statsRows, ['category', 'MAE', 'Spearman_rho', 'n']));

  console.log(
    `\nMAE avg: ${fmt(mean(maes), 4, 2).trim()}, ρ avg: ${fmt(mean(rhos), 5, 3).trim()}  ` +
      `(${okResults.length}/${samples.length} samples ok, ${elapsed}s)`
  );

  // Brief aiSummary preview (optional sanity check)
  console.log('\naiSummary preview:');
  for (const r of okResults) {
    const sum = r.aiSummary.length > 110 ? r.aiSummary.slice(0, 107) + '...' : r.aiSummary;
    console.log(`  ${r.sample.padEnd(14)} ${sum}`);
  }

  return errors.length === 0 ? 0 : 1;
}

async function modeDeterminism(token, sample) {
  // Normalize: allow "sample5" or "sample5.jpg"
  const file = sample.endsWith('.jpg') ? sample : `${sample}.jpg`;
  const photo = readPhoto(file);
  const RUNS = 5;

  console.log(`Running determinism check on ${file} (${RUNS} runs in parallel)...\n`);

  const t0 = Date.now();
  const results = await Promise.all(
    Array.from({ length: RUNS }, async (_, i) => {
      try {
        const parsed = await callVertex({ token, photoBuffer: photo, metricsText: BASELINE_METRICS });
        return { run: i + 1, predicted: extractScores(parsed), ok: true };
      } catch (err) {
        return { run: i + 1, error: err.message, ok: false };
      }
    })
  );
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const errors = results.filter((r) => !r.ok);
  if (errors.length === RUNS) {
    console.log(`All ${RUNS} runs failed:`);
    for (const e of errors) console.log(`  run ${e.run}: ${e.error}`);
    return 1;
  }

  // Per-run table
  const headers = ['run', ...CATEGORIES];
  const rows = results.map((r) =>
    r.ok ? [String(r.run), ...CATEGORIES.map((c) => fmt(r.predicted[c], 4, 0).trim())] : [String(r.run), ...CATEGORIES.map(() => 'ERR')]
  );
  console.log('Per-run scores:');
  console.log(table(rows, headers));

  // Stats per category
  const statsRows = [];
  const ok = results.filter((r) => r.ok);
  for (const cat of CATEGORIES) {
    const xs = ok.map((r) => r.predicted[cat]);
    const m = mean(xs);
    const s = stddev(xs);
    const flag = Number.isFinite(s) && s > 2 ? 'WARN' : '';
    statsRows.push([cat, fmt(m, 5, 2).trim(), fmt(s, 5, 2).trim(), String(xs.filter(Number.isFinite).length), flag]);
  }
  console.log('\nPer-category determinism (WARN if stddev > 2):');
  console.log(table(statsRows, ['category', 'mean', 'stddev', 'n', 'flag']));

  console.log(`\n${ok.length}/${RUNS} runs ok, ${elapsed}s`);
  if (errors.length) {
    for (const e of errors) console.log(`  run ${e.run} error: ${e.error}`);
  }

  return errors.length === 0 ? 0 : 1;
}

// ---------- cli ----------

function printHelp() {
  console.log(`OnFrame Vertex AI Gemini eval harness

Usage:
  node eval.mjs                       quality vs labels (all samples)
  node eval.mjs -d <sample>           determinism check (5 runs on one sample)
  node eval.mjs --determinism <s>     same
  node eval.mjs -h | --help           show this help

Examples:
  node eval.mjs
  node eval.mjs -d sample5
  node eval.mjs -d sample5.jpg

Reads labels from onframe/eval/labels.json.
Reads sample photos from onframe/web/sample/.
Calls Vertex AI (project ${PROJECT}, ${LOCATION}, ${MODEL}) via ADC.
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    printHelp();
    return 0;
  }

  let detSample = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-d' || argv[i] === '--determinism') {
      detSample = argv[i + 1];
      if (!detSample) {
        console.error('error: -d/--determinism requires a sample name (e.g. sample5)');
        return 2;
      }
      break;
    }
  }

  const token = await getAccessToken();
  if (detSample) return modeDeterminism(token, detSample);
  return modeQuality(token);
}

main()
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    console.error('FATAL:', err?.stack || err?.message || err);
    process.exit(1);
  });
