/**
 * cloud.js — Groq proxy client
 * Sends humanReadableSummary (text only, no pixels) to the server-side proxy.
 */

const BASE_URL = import.meta.env.BASE_URL || '/';
const APP_BASE_URL = BASE_URL.replace(/\/+$/, '');
const ANALYZE_URL = `${APP_BASE_URL}/api/analyze`;

async function parseJsonResponse(res, fallbackMessage) {
  let payload = null;
  try {
    payload = await res.json();
  } catch (_) {
    if (!res.ok) {
      throw new Error(fallbackMessage);
    }
  }

  if (!res.ok) {
    throw new Error(payload?.error || fallbackMessage);
  }

  return payload;
}

export async function fetchCloudCoaching(metrics) {
  if (!metrics?.humanReadableSummary) {
    throw new Error('Cloud coaching needs a completed local analysis summary');
  }

  const res = await fetch(ANALYZE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary: metrics.humanReadableSummary }),
    signal: AbortSignal.timeout(15_000),
  });

  return parseJsonResponse(res, `Server error ${res.status}`);
}
