/**
 * device.js — runtime detection for OnFrame's mobile-only gate.
 *
 * Mobile = narrow viewport, OR coarse pointer, OR has touch points.
 * The maxTouchPoints check catches iPad in "Request Desktop Site" mode,
 * where Safari lies about pointer type and viewport width but still
 * reports the real touch capability.
 */
export function isMobileDevice(win = typeof window !== 'undefined' ? window : null) {
  if (!win || typeof win.matchMedia !== 'function') return false;
  const touchPoints = win.navigator?.maxTouchPoints ?? 0;
  return win.matchMedia('(max-width: 820px)').matches
      || win.matchMedia('(pointer: coarse)').matches
      || touchPoints > 0;
}
