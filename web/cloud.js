/**
 * cloud.js — Vertex AI Gemma proxy client.
 *
 * Sends the downscaled JPEG + local measurements to the server, which
 * forwards to Vertex AI Gemma. Server returns `{ aiSummary, aiUnavailable }`.
 *
 * Failure handling: any error (validation, network, parse, non-OK status)
 * resolves to `{ aiUnavailable: true }`. We never throw to the caller —
 * the caller falls back to the local synthesizer cards.
 */

import { downscaleImage } from './downscale.js';

const BASE_URL = import.meta.env.BASE_URL || '/';
const APP_BASE_URL = BASE_URL.replace(/\/+$/, '');
const ANALYZE_URL = `${APP_BASE_URL}/api/analyze`;
const REQUEST_TIMEOUT_MS = 20_000;

function isBlobLike(value) {
  return value && typeof value === 'object' && typeof value.arrayBuffer === 'function';
}

function getSummary(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;
  // Accept either the new flat shape ({ summary, ... }) or the legacy
  // analyzeImage shape ({ humanReadableSummary, ... }).
  const summary = metrics.summary || metrics.humanReadableSummary;
  if (typeof summary !== 'string' || !summary.trim()) return null;
  return summary;
}

export async function fetchCloudCoaching(file, metrics) {
  try {
    if (!isBlobLike(file)) {
      return { aiUnavailable: true };
    }
    const summary = getSummary(metrics);
    if (!summary) {
      return { aiUnavailable: true };
    }

    let photoBlob;
    try {
      photoBlob = await downscaleImage(file);
    } catch (_) {
      return { aiUnavailable: true };
    }

    const metricsPayload = JSON.stringify({
      summary,
      photoType: metrics.photoType ?? null,
      localScores: metrics.localScores ?? null,
      localCards: metrics.localCards ?? null,
    });

    const form = new FormData();
    form.append('photo', photoBlob, 'photo.jpg');
    form.append('metrics', metricsPayload);

    let res;
    try {
      res = await fetch(ANALYZE_URL, {
        method: 'POST',
        body: form,
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
          ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
          : undefined,
      });
    } catch (_) {
      return { aiUnavailable: true };
    }

    if (!res || !res.ok) {
      return { aiUnavailable: true };
    }

    try {
      const body = await res.json();
      if (!body || typeof body !== 'object') {
        return { aiUnavailable: true };
      }
      return body;
    } catch (_) {
      return { aiUnavailable: true };
    }
  } catch (_) {
    // Belt-and-suspenders — never throw to the caller.
    return { aiUnavailable: true };
  }
}
