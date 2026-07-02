// The mobile-gate <script> in index.html is inline, and the onframe CSP is
// script-src 'self' without 'unsafe-inline' — so the script only runs if the
// CSP carries its exact sha256 hash. This test pins the two together: change
// the inline script and the hash in deploy/nginx.conf must be regenerated.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(here, '..', 'index.html');
const NGINX_CONF = join(here, '..', '..', '..', 'deploy', 'nginx.conf');

function inlineScriptHash(html) {
  // First <script> without src — the synchronous mobile gate. CSP hashes the
  // exact bytes between the tags, whitespace included.
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('no inline <script> found in index.html');
  return createHash('sha256').update(match[1], 'utf8').digest('base64');
}

// The nginx locations that serve onframe HTML (exact /onframe/ and the SPA
// fallback). Their blocks have no nested braces, so [^}]* captures each body.
function onframeHtmlCspLines(conf) {
  const blocks = [...conf.matchAll(/location\s+=?\s*\/onframe\/\s*\{([^}]*)\}/g)];
  return blocks
    .map(([, body]) => body.split('\n').find((line) => line.includes('Content-Security-Policy')))
    .filter(Boolean);
}

describe('onframe CSP inline-script hash', () => {
  it('nginx onframe CSP includes the sha256 of the inline mobile-gate script', () => {
    const hash = inlineScriptHash(readFileSync(INDEX_HTML, 'utf8'));
    const cspLines = onframeHtmlCspLines(readFileSync(NGINX_CONF, 'utf8'));
    expect(cspLines.length).toBe(2);
    for (const line of cspLines) {
      expect(line).toContain(`'sha256-${hash}'`);
    }
  });
});
