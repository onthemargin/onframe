import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const html = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../index.html'), 'utf8');

// Index just past the </div> that closes the element carrying id=`${id}`.
function divEnd(id) {
  const idPos = html.indexOf(`id="${id}"`);
  expect(idPos).toBeGreaterThan(-1);
  let i = html.indexOf('>', idPos) + 1;
  let depth = 1;
  while (depth > 0) {
    const open = html.indexOf('<div', i);
    const close = html.indexOf('</div>', i);
    if (close === -1) break;
    if (open !== -1 && open < close) { depth++; i = open + 4; }
    else { depth--; i = close + 6; }
  }
  return i;
}

describe('report confirmation survives the form collapsing on send', () => {
  // sendReport() hides the form div on success, then writes "Sent…" into the
  // result element. If result is INSIDE the form it is hidden the instant it is
  // set — the user sees no confirmation. So result must be a SIBLING, placed
  // AFTER the form's closing tag.
  for (const [formId, resultId] of [
    ['report-form', 'report-result'],
    ['error-report-form', 'error-report-result'],
  ]) {
    it(`${resultId} is not nested inside ${formId}`, () => {
      const resultPos = html.indexOf(`id="${resultId}"`);
      expect(resultPos).toBeGreaterThan(divEnd(formId));
    });
  }
});
