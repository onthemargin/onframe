// Standalone mode (STATIC_DIR set) has no nginx in front, so Express itself
// must ship the security headers on the static frontend — in the monorepo
// nginx owns them. The CSP inline-script hash is computed from the served
// index.html at startup so it can never drift from the markup.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import serverModule from '../server.js';

const { createApp } = serverModule;
const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'static');
// sha256 of the fixture's inline <script> body ("var x = 1;")
const FIXTURE_SCRIPT_HASH = '9nfWt3DNT14o+tZCP3YilfLwTrhLI98eqbN689B7ajY=';

function buildStandaloneApp() {
  return createApp({ staticDir: STATIC_DIR, vertexClient: null });
}

const EXPECTED_HEADERS = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-site',
  'permissions-policy': 'camera=(self), microphone=(), geolocation=(), payment=()',
  'x-permitted-cross-domain-policies': 'none',
};

describe('standalone mode security headers', () => {
  it('serves the app HTML with the full security header set', async () => {
    const res = await request(buildStandaloneApp()).get('/onframe/');
    expect(res.status).toBe(200);
    for (const [name, value] of Object.entries(EXPECTED_HEADERS)) {
      expect(res.headers[name], name).toBe(value);
    }
  });

  it('CSP disallows unsafe-inline scripts but hashes the inline mobile-gate script', async () => {
    const res = await request(buildStandaloneApp()).get('/onframe/');
    const csp = res.headers['content-security-policy'];
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain(`'sha256-${FIXTURE_SCRIPT_HASH}'`);
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src'));
    expect(scriptSrc).not.toContain('unsafe-inline');
  });

  it('sets the headers on the SPA fallback too', async () => {
    const res = await request(buildStandaloneApp()).get('/onframe/some/deep/route');
    expect(res.status).toBe(200);
    expect(res.headers['strict-transport-security']).toBe(EXPECTED_HEADERS['strict-transport-security']);
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('monorepo mode (no staticDir) is unchanged — nginx owns the headers there', async () => {
    const res = await request(createApp({ vertexClient: null })).get('/onframe/api/health');
    expect(res.status).toBe(200);
    expect(res.headers['strict-transport-security']).toBeUndefined();
    expect(res.headers['content-security-policy']).toBeUndefined();
  });
});
