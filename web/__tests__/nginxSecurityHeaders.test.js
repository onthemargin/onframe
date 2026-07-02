// nginx quirk: a location that declares ANY add_header loses ALL inherited
// server-level add_headers. So every /onframe/ location that sets its own
// headers (Cache-Control on assets/models/wasm) must re-declare the security
// set — otherwise those responses ship without HSTS et al. This test walks
// every onframe location block and asserts the re-declaration is complete.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const NGINX_CONF = join(here, '..', '..', '..', 'deploy', 'nginx.conf');

// Brace-counting block extractor (location bodies can nest e.g. types { ... }).
function locationBlocks(conf, pathPrefix) {
  const blocks = [];
  const re = new RegExp(String.raw`location\s+=?\s*${pathPrefix.replace(/\//g, '\\/')}[^\s{]*\s*\{`, 'g');
  let match;
  while ((match = re.exec(conf)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    while (i < conf.length && depth > 0) {
      if (conf[i] === '{') depth++;
      else if (conf[i] === '}') depth--;
      i++;
    }
    blocks.push({ header: match[0], body: conf.slice(match.index + match[0].length, i - 1) });
  }
  return blocks;
}

const REQUIRED_HEADERS = [
  'Strict-Transport-Security',
  'X-Frame-Options',
  'X-Content-Type-Options',
  'Referrer-Policy',
  'Cross-Origin-Opener-Policy',
  'Cross-Origin-Resource-Policy',
  'Permissions-Policy',
  'X-Permitted-Cross-Domain-Policies',
];

describe('onframe nginx locations re-declare security headers', () => {
  const conf = readFileSync(NGINX_CONF, 'utf8');
  const blocks = locationBlocks(conf, '/onframe').filter((b) => b.body.includes('add_header'));

  it('finds the onframe locations that set their own headers', () => {
    // HTML (×2) + models + mediapipe + assets
    expect(blocks.length).toBeGreaterThanOrEqual(5);
  });

  it.each(REQUIRED_HEADERS)('%s is set in every header-declaring onframe location', (header) => {
    for (const { header: loc, body } of blocks) {
      expect(body.includes(header), `${header} missing in "${loc.trim()}"`).toBe(true);
    }
  });
});
