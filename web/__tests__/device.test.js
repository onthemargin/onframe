import { describe, it, expect } from 'vitest';
import { isMobileDevice } from '../device.js';

function makeWindow({ width = 1280, pointer = 'fine', maxTouchPoints = 0 } = {}) {
  return {
    matchMedia: (query) => {
      if (query === '(pointer: coarse)') return { matches: pointer === 'coarse' };
      if (query === '(pointer: fine)')   return { matches: pointer === 'fine' };
      const m = query.match(/\(max-width:\s*(\d+)px\)/);
      if (m) return { matches: width <= Number(m[1]) };
      return { matches: false };
    },
    navigator: { maxTouchPoints },
  };
}

describe('isMobileDevice', () => {
  it('returns true for narrow viewport with coarse pointer (phone)', () => {
    expect(isMobileDevice(makeWindow({ width: 390, pointer: 'coarse' }))).toBe(true);
  });

  it('returns true for narrow viewport even with fine pointer', () => {
    // Resized desktop browser — treat as mobile so devs/responsive testing works.
    expect(isMobileDevice(makeWindow({ width: 500, pointer: 'fine' }))).toBe(true);
  });

  it('returns true for coarse pointer even on a wide viewport (tablet)', () => {
    expect(isMobileDevice(makeWindow({ width: 1024, pointer: 'coarse' }))).toBe(true);
  });

  it('returns false for wide viewport with fine pointer (desktop)', () => {
    expect(isMobileDevice(makeWindow({ width: 1440, pointer: 'fine' }))).toBe(false);
  });

  it('returns true for iPad in desktop-site mode (lies about pointer/width but maxTouchPoints > 0)', () => {
    // iPadOS Safari "Request Desktop Site" default: reports pointer: fine,
    // wide viewport, but navigator.maxTouchPoints stays truthful (>= 5).
    expect(isMobileDevice(makeWindow({ width: 1366, pointer: 'fine', maxTouchPoints: 5 }))).toBe(true);
  });

  it('returns false for desktop with no touch points (Mac with mouse)', () => {
    expect(isMobileDevice(makeWindow({ width: 1440, pointer: 'fine', maxTouchPoints: 0 }))).toBe(false);
  });

  it('returns false when no window is available (SSR safety)', () => {
    expect(isMobileDevice(null)).toBe(false);
  });
});
