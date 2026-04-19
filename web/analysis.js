/**
 * analysis.js — OnFrame browser analysis pipeline
 * Runs MediaPipe FaceLandmarker + canvas pixel analysis to produce VisionMetrics.
 */

import { FaceLandmarker, PoseLandmarker, FilesetResolver }
  from './mediapipe/vision_bundle.mjs';
import { computeHeadroomRatio } from './composition.js';

let _faceLandmarker = null;
let _poseLandmarker = null;
let _initPromise = null;
const BASE_URL = import.meta.env.BASE_URL || '/';

function resolveBasePath(path) {
  return `${BASE_URL.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

const FACE_MODEL_URL = resolveBasePath('models/face_landmarker.task');
const POSE_MODEL_URL = resolveBasePath('models/pose_landmarker_lite.task');
const MEDIAPIPE_WASM_ROOT = resolveBasePath('mediapipe/wasm');

function describeLoadError(err, fallback = 'Required analysis assets failed to load') {
  if (err instanceof Error && err.message && err.message !== '[object Event]') {
    return err.message;
  }
  if (typeof Event !== 'undefined' && err instanceof Event) {
    const target = err.target || err.currentTarget;
    const src = target?.src || target?.currentSrc || target?.href;
    return src ? `${fallback}: ${src}` : fallback;
  }
  if (typeof err === 'string' && err.trim()) return err;
  return fallback;
}

function clampRect(x, y, width, height, maxW, maxH) {
  const clampedX = Math.max(0, Math.min(maxW - 1, Math.round(x)));
  const clampedY = Math.max(0, Math.min(maxH - 1, Math.round(y)));
  const clampedW = Math.max(1, Math.min(maxW - clampedX, Math.round(width)));
  const clampedH = Math.max(1, Math.min(maxH - clampedY, Math.round(height)));
  return { x: clampedX, y: clampedY, width: clampedW, height: clampedH };
}

export async function loadMediaPipe() {
  if (_faceLandmarker) return { face: _faceLandmarker, pose: _poseLandmarker };
  if (_initPromise)    return _initPromise;

  _initPromise = (async () => {
    try {
      const vision = await FilesetResolver.forVisionTasks(
        MEDIAPIPE_WASM_ROOT
      );
      _faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: FACE_MODEL_URL },
        runningMode: 'IMAGE',
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
        numFaces: 1,
        minFaceDetectionConfidence: 0.25,
        minFacePresenceConfidence: 0.25,
      });
      _poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: POSE_MODEL_URL },
        runningMode: 'IMAGE',
        numPoses: 1,
      });
      return { face: _faceLandmarker, pose: _poseLandmarker };
    } catch (err) {
      _faceLandmarker = null;
      _poseLandmarker = null;
      _initPromise = null;
      throw new Error(describeLoadError(
        err,
        'Could not load on-device analysis assets. Refresh the page and try again'
      ));
    }
  })();

  return _initPromise;
}

// ─── Canvas setup ────────────────────────────────────────────────────────────

async function drawToCanvas(file) {
  // Use Image element as primary — it reliably applies EXIF orientation
  // across all browsers including iOS Safari. createImageBitmap can
  // return un-rotated pixels on some platforms.
  const MAX = 2048;
  const url = URL.createObjectURL(file);
  const source = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not load image')); };
    img.src = url;
  });
  let w = source.naturalWidth, h = source.naturalHeight;
  URL.revokeObjectURL(url);
  if (w < 10 || h < 10) throw new Error('Image is too small to analyze');
  if (w > MAX || h > MAX) {
    const s = Math.min(MAX / w, MAX / h);
    w = Math.round(w * s); h = Math.round(h * s);
  }
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  // Force sRGB color space — Safari defaults to Display P3 which
  // can cause MediaPipe WASM face detection to fail silently.
  const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  ctx.drawImage(source, 0, 0, w, h);
  source.src = '';
  return { canvas, ctx, w, h };
}

function clearImageData(canvas, ctx) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvas.width = 1;
}

// ─── Head pose from 4×4 column-major matrix ──────────────────────────────────

function extractHeadPose(matrix) {
  const d = matrix.data;
  const r12 = d[9], r02 = d[8], r22 = d[10], r10 = d[1], r11 = d[5];
  return {
    pitch: Math.asin(-r12),
    yaw:   Math.atan2(r02, r22),
    roll:  Math.atan2(r10, r11),
  };
}

// ─── Face bounding box from landmarks ────────────────────────────────────────

function faceBBox(landmarks, w, h) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const lm of landmarks) {
    if (lm.x < minX) minX = lm.x;
    if (lm.y < minY) minY = lm.y;
    if (lm.x > maxX) maxX = lm.x;
    if (lm.y > maxY) maxY = lm.y;
  }
  return clampRect(minX * w, minY * h, (maxX - minX) * w, (maxY - minY) * h, w, h);
}

// ─── Sharpness (Laplacian variance) ──────────────────────────────────────────

function laplacianVariance(ctx, x, y, width, height) {
  const { data } = ctx.getImageData(x, y, width, height);
  const luma = (i) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  let variance = 0, count = 0;
  for (let row = 1; row < height - 1; row++) {
    for (let col = 1; col < width - 1; col++) {
      const i = (row * width + col) * 4;
      const lap = -4 * luma(i)
        + luma(i - 4) + luma(i + 4)
        + luma(i - width * 4) + luma(i + width * 4);
      variance += lap * lap;
      count++;
    }
  }
  const meanLapSq = variance / Math.max(count, 1);
  // Normalise to 0–1: divide by 500 to match Python analyzer calibration.
  // Sharp photos land ~0.6–0.9, soft photos ~0.2–0.5, blurry < 0.2.
  return Math.min(1.0, meanLapSq / 500);
}

// ─── Eye obscured detection (sunglasses) ─────────────────────────────────────

function isEyeRegionDark(ctx, cx, cy, w, h, radius = 20) {
  const px = Math.round(cx * w), py = Math.round(cy * h);
  const ox = Math.max(0, px - radius), oy = Math.max(0, py - radius);
  const ew = Math.min(w - ox, radius * 2), eh = Math.min(h - oy, radius * 2);
  if (ew < 4 || eh < 4) return false;
  const { data } = ctx.getImageData(ox, oy, ew, eh);
  let sum = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return (sum / n) < 40; // very dark eye region = likely sunglasses
}

// ─── Per-eye sharpness ───────────────────────────────────────────────────────

function eyeRegionSharpness(ctx, cx, cy, w, h, radius = 25) {
  const px = Math.round(cx * w), py = Math.round(cy * h);
  const ox = Math.max(0, px - radius), oy = Math.max(0, py - radius);
  const ew = Math.min(w - ox, radius * 2), eh = Math.min(h - oy, radius * 2);
  if (ew < 4 || eh < 4) return 0;
  return laplacianVariance(ctx, ox, oy, ew, eh);
}

// ─── Exposure EV ─────────────────────────────────────────────────────────────

function computeExposureEV(ctx, w, h) {
  const { data } = ctx.getImageData(0, 0, w, h);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4)
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  const meanLuma = (sum / (data.length / 4)) / 255;
  return Math.log2(Math.max(meanLuma, 0.001) / 0.18);
}

// ─── Lighting ratio ───────────────────────────────────────────────────────────

function computeLightingRatio(ctx, faceRect, w, h) {
  if (faceRect.width < 2) return { ratio: 1, direction: 'left' };
  const leftWidth = Math.max(1, Math.floor(faceRect.width / 2));
  const rightWidth = Math.max(1, faceRect.width - leftWidth);
  const leftRect = clampRect(faceRect.x, faceRect.y, leftWidth, faceRect.height, w, h);
  const rightRect = clampRect(
    faceRect.x + faceRect.width - rightWidth,
    faceRect.y,
    rightWidth,
    faceRect.height,
    w,
    h
  );
  const avg = (d) => {
    let s = 0;
    for (let i = 0; i < d.length; i += 4)
      s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    return s / (d.length / 4);
  };
  const L = avg(ctx.getImageData(leftRect.x, leftRect.y, leftRect.width, leftRect.height).data);
  const R = avg(ctx.getImageData(rightRect.x, rightRect.y, rightRect.width, rightRect.height).data);
  return {
    ratio: Math.max(L, R) / Math.max(Math.min(L, R), 0.001),
    direction: L > R ? 'left' : 'right',
  };
}

// ─── Catchlight detection ─────────────────────────────────────────────────────

function detectCatchlight(ctx, cx, cy, imgW, imgH) {
  const S = 60, H = S / 2;
  const px = Math.round(cx * imgW), py = Math.round(cy * imgH);
  const ox = Math.max(0, px - H), oy = Math.max(0, py - H);
  const sw = Math.min(imgW - ox, S), sh = Math.min(imgH - oy, S);
  if (sw < 4 || sh < 4) return { detected: false, clockHour: null };
  const { data } = ctx.getImageData(ox, oy, sw, sh);
  // Compute luma stats + max. A catchlight is a localized bright spot
  // noticeably brighter than the iris around it, so compare to local mean.
  let maxL = 0, bx = H, by = H, sum = 0, brightPixels = 0, n = sw * sh;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const i = (y * sw + x) * 4;
      const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += l;
      if (l >= 200) brightPixels++;
      if (l > maxL) { maxL = l; bx = x; by = y; }
    }
  }
  const mean = sum / n;
  const brightFraction = brightPixels / Math.max(n, 1);
  // Detect if the brightest pixel is both absolutely bright-ish AND meaningfully
  // above the local mean. Lowered absolute threshold for darker portraits.
  if (maxL < 180 || maxL - mean < 25 || brightFraction < 0.002) {
    return { detected: false, clockHour: null };
  }
  const dx = bx - H, dy = H - by;
  const deg = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
  const clockHour = Math.round(((90 - deg + 360) % 360) / 30) || 12;
  return { detected: true, clockHour };
}

// ─── Color cast ───────────────────────────────────────────────────────────────

function detectColorCast(ctx, faceRect) {
  const { data } = ctx.getImageData(faceRect.x, faceRect.y, faceRect.width, faceRect.height);
  let R = 0, G = 0, B = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) { R += data[i]; G += data[i + 1]; B += data[i + 2]; }
  R /= n; G /= n; B /= n;
  return {
    warmth:      (R - B) / 255,
    greenShift:  (G - (R + B) / 2) / 255,
    isGreenCast: G > R + 15 && G > B + 15,
    isCoolCast:  B > R + 20,
    isWarm:      R > B + 15,
  };
}

// ─── Skin smoothness ──────────────────────────────────────────────────────────

function computeSkinSmoothness(ctx, faceRect) {
  // Sample two small cheek patches — these avoid eyes, nose, lips, brow,
  // and hair, all of which are shadow/edge sources that inflate stddev
  // and made every face look "harsh" in the old full-bbox implementation.
  const fw = faceRect.width, fh = faceRect.height;
  // Cheek patches: roughly 15% of face width, centered on the cheek
  // (~60% down the face, ~20% in from each side).
  const patchW = Math.max(4, Math.round(fw * 0.15));
  const patchH = Math.max(4, Math.round(fh * 0.12));
  const patchY = faceRect.y + Math.round(fh * 0.55);
  const leftX  = faceRect.x + Math.round(fw * 0.15);
  const rightX = faceRect.x + fw - Math.round(fw * 0.15) - patchW;

  const sampleStddev = (x, y) => {
    if (x < 0 || y < 0 || x + patchW > ctx.canvas.width || y + patchH > ctx.canvas.height) return null;
    const { data } = ctx.getImageData(x, y, patchW, patchH);
    let sum = 0, sum2 = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += l; sum2 += l * l;
    }
    const mean = sum / n;
    return Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  };

  const sdL = sampleStddev(leftX,  patchY);
  const sdR = sampleStddev(rightX, patchY);
  const readings = [sdL, sdR].filter(v => v !== null);
  if (readings.length === 0) return 0.5;
  // Use the minimum (smoother cheek) so a single harshly-shadowed side
  // doesn't dominate. Typical well-lit cheek stddev: 4–12. Harsh: 20+.
  const stddev = Math.min(...readings);
  return 1 - Math.min(1, stddev / 45);
}

// ─── Background brightness ────────────────────────────────────────────────────

function computeBackgroundBrightness(ctx, faceRect, w, h) {
  // Sample a strip above, left, and right of the face region
  let sum = 0, cnt = 0;
  const sample = (x, y, sw, sh) => {
    if (sw < 1 || sh < 1) return;
    const { data } = ctx.getImageData(
      Math.max(0, x), Math.max(0, y),
      Math.min(w - Math.max(0, x), sw), Math.min(h - Math.max(0, y), sh)
    );
    for (let i = 0; i < data.length; i += 4)
      sum += (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
    cnt += data.length / 4;
  };
  // above face
  if (faceRect.y > 10) sample(0, 0, w, faceRect.y);
  // left of face
  if (faceRect.x > 10) sample(0, faceRect.y, faceRect.x, faceRect.height);
  // right of face
  const rightX = faceRect.x + faceRect.width;
  if (rightX < w - 10) sample(rightX, faceRect.y, w - rightX, faceRect.height);

  return cnt > 0 ? sum / cnt : 0.5;
}

// ─── Squinch ratio from landmarks ────────────────────────────────────────────

function computeSquinchFromLandmarks(landmarks) {
  const rUpperGap = landmarks[468].y - landmarks[159].y;
  const rLowerGap = landmarks[145].y - landmarks[468].y;
  const rRatio = rLowerGap / Math.max(Math.abs(rUpperGap), 0.001);

  const lUpperGap = landmarks[473].y - landmarks[386].y;
  const lLowerGap = landmarks[374].y - landmarks[473].y;
  const lRatio = lLowerGap / Math.max(Math.abs(lUpperGap), 0.001);

  const avg = (rRatio + lRatio) / 2;
  return {
    ratio: avg,
    isSquinching: avg < 0.80,
    isWideEyed:   avg > 1.10,
  };
}

// ─── Squinch from blendshapes ────────────────────────────────────────────────

function computeSquinchFromBlendshapes(blendshapes) {
  const get = (name) => blendshapes.find(b => b.categoryName === name)?.score ?? 0;
  const squintL = get('eyeSquintLeft'), squintR = get('eyeSquintRight');
  const avg = (squintL + squintR) / 2;
  return {
    ratio: 1 - avg,   // blendshape 0=open, 1=squint → invert to match landmark ratio convention
    isSquinching: avg > 0.10 && avg < 0.60,
    isWideEyed:   avg < 0.02,
    blendshapeBased: true,
  };
}

// ─── Duchenne smile from blendshapes ─────────────────────────────────────────

function computeDuchenneSmile(blendshapes) {
  const get = (name) => blendshapes.find(b => b.categoryName === name)?.score ?? 0;
  const mouthSmile = (get('mouthSmileLeft') + get('mouthSmileRight')) / 2;
  // Use eye-squint as the Duchenne marker. Cheek-squint blendshapes run very
  // low on most faces (~0.0–0.1) while eye-squint tracks the lower-lid lift
  // that's the actual Duchenne signal (orbicularis oculi engagement).
  const eyeSquint  = (get('eyeSquintLeft')  + get('eyeSquintRight'))  / 2;
  const cheekRaise = (get('cheekSquintLeft') + get('cheekSquintRight')) / 2;
  const eyeCrinkle = Math.max(eyeSquint, cheekRaise);
  return {
    isSmiling:   mouthSmile > 0.15,
    isDuchenne:  mouthSmile > 0.15 && eyeCrinkle > 0.10,
    mouthSmile, eyeCrinkle,
  };
}

// ─── Iris-to-sclera ratio ─────────────────────────────────────────────────────

function computeIrisToScleraRatio(landmarks, w, h) {
  const sy = (v) => v * h;
  const sx = (v) => v * w;
  const rIrisY  = sy(landmarks[468].y);
  const rUpperY = sy(landmarks[159].y);
  const rLowerY = sy(landmarks[145].y);
  const aperture = rLowerY - rUpperY;
  // MediaPipe iris perimeter points 469/471 are on the HORIZONTAL axis of the
  // iris — use their x-distance (scaled to pixels) as the iris diameter.
  const rIrisDiameter = Math.abs(sx(landmarks[471].x) - sx(landmarks[469].x));
  const rIrisRadius   = rIrisDiameter / 2;
  const coverage = rIrisDiameter / Math.max(aperture, 1);
  const inferiorScleral = (rLowerY - rIrisY - rIrisRadius) / Math.max(aperture, 1);
  return { coverage: Math.max(0, Math.min(1, coverage)), inferiorScleral: Math.max(0, inferiorScleral) };
}

// ─── Lip gap ─────────────────────────────────────────────────────────────────

function computeLipGap(landmarks, faceHeight) {
  const gap = Math.abs(landmarks[14].y - landmarks[13].y) / faceHeight;
  return { ratio: gap, isClosed: gap < 0.005, isNatural: gap >= 0.005 && gap <= 0.030 };
}

// ─── Crop line safety ────────────────────────────────────────────────────────

function computeCropLineSafety(faceRect, imgH) {
  const faceBottom = faceRect.y + faceRect.height;
  const belowChin  = imgH - faceBottom;
  const fH = faceRect.height;
  if (belowChin < fH * 0.05) return 'chin-clipped';
  if (belowChin < fH * 0.25) return 'chin-neck-crop';
  if (belowChin < fH * 0.55) return 'shoulder-crop';
  return 'safe';
}

// ─── Lead-room violation ─────────────────────────────────────────────────────

function computeLeadRoomViolation(yawRad, horizontalOffset) {
  const gazingRight = yawRad >  0.15;
  const gazingLeft  = yawRad < -0.15;
  if (gazingRight && horizontalOffset >  0.3) return true;
  if (gazingLeft  && horizontalOffset < -0.3) return true;
  return false;
}

// ─── View type name ───────────────────────────────────────────────────────────

function viewTypeName(yawDeg) {
  const a = Math.abs(yawDeg);
  if (a < 5)  return 'Full frontal';
  if (a < 15) return '7/8 view';
  if (a < 30) return 'Classic 3/4 view';
  if (a < 45) return '2/3 view';
  return 'Strong turn';
}

// ─── Lighting pattern ─────────────────────────────────────────────────────────

function classifyLightingPattern(ratio, clockPos) {
  if (!clockPos)                                                    return 'flat';
  if (ratio > 4.0 && (clockPos === 3 || clockPos === 9))           return 'split';
  if (ratio > 3.0 && clockPos >= 4 && clockPos <= 8)               return 'Rembrandt';
  if (ratio < 1.5 && (clockPos >= 11 || clockPos <= 1))            return 'butterfly';
  if (ratio >= 1.5 && ratio <= 3.5 && (clockPos >= 10 || clockPos <= 2)) return 'loop';
  return 'directional';
}

function broadVsShort(yawRad, lightingDirection) {
  // Only classify broad/short for genuine 3/4 turns (>15°). Near-frontal
  // poses don't have a meaningful broad-vs-short distinction.
  const faceRight = yawRad >  0.26;
  const faceLeft  = yawRad < -0.26;
  if (!faceRight && !faceLeft) return 'frontal';
  if (faceRight && lightingDirection === 'right') return 'broad';
  if (faceRight && lightingDirection === 'left')  return 'short';
  if (faceLeft  && lightingDirection === 'left')  return 'broad';
  if (faceLeft  && lightingDirection === 'right') return 'short';
  return 'unknown';
}

// ─── Background blur / subject isolation ─────────────────────────────────────

function computeSubjectIsolation(ctx, faceRect, w, h) {
  // Compare sharpness (Laplacian variance) of face vs background
  const faceSharpness = laplacianVariance(ctx, faceRect.x, faceRect.y, faceRect.width, faceRect.height);

  // Sample background regions (above, left, right of face)
  const bgRegions = [];
  if (faceRect.y > 20) bgRegions.push([0, 0, w, Math.min(faceRect.y, h)]);
  if (faceRect.x > 20) bgRegions.push([0, faceRect.y, faceRect.x, faceRect.height]);
  const rx = faceRect.x + faceRect.width;
  if (rx < w - 20) bgRegions.push([rx, faceRect.y, w - rx, faceRect.height]);

  if (bgRegions.length === 0) return { ratio: 1, faceSharpness, bgSharpness: 0 };

  let bgTotal = 0;
  for (const [bx, by, bw, bh] of bgRegions) {
    bgTotal += laplacianVariance(ctx, Math.round(bx), Math.round(by), Math.round(bw), Math.round(bh));
  }
  const bgSharpness = bgTotal / bgRegions.length;
  const ratio = bgSharpness > 0.001 ? faceSharpness / bgSharpness : 10;
  return { ratio, faceSharpness, bgSharpness };
}

// ─── Face tonal range / clipping ─────────────────────────────────────────────

function computeFaceTonalRange(ctx, faceRect) {
  const { data } = ctx.getImageData(faceRect.x, faceRect.y, faceRect.width, faceRect.height);
  const n = data.length / 4;
  let clippedHighlight = 0, clippedShadow = 0;
  for (let i = 0; i < data.length; i += 4) {
    const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (l > 248) clippedHighlight++;
    if (l < 8)   clippedShadow++;
  }
  return {
    highlightClipPct: clippedHighlight / n,
    shadowClipPct:    clippedShadow / n,
  };
}

// ─── Expression tension from blendshapes ─────────────────────────────────────

function computeExpressionTension(blendshapes) {
  if (!blendshapes.length) return { browTension: 0, jawTension: 0, hasTension: false };

  const get = (name) => {
    const bs = blendshapes.find(b => b.categoryName === name);
    return bs ? bs.score : 0;
  };

  const browTension = (get('browDownLeft') + get('browDownRight')) / 2;
  const jawTension  = get('jawOpen') < 0.02 ? (get('mouthPressLeft') + get('mouthPressRight')) / 2 : 0;

  return {
    browTension,
    jawTension,
    hasTension: browTension > 0.3 || jawTension > 0.3,
  };
}

// ─── Body pose analysis ──────────────────────────────────────────────────────

// Pose landmark indices
const PL = {
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13,    R_ELBOW: 14,
  L_WRIST: 15,    R_WRIST: 16,
  L_HIP: 23,      R_HIP: 24,
  L_KNEE: 25,     R_KNEE: 26,
  L_ANKLE: 27,    R_ANKLE: 28,
};

function analyzeBodyPose(poseResult, imgH) {
  const empty = {
    hasPose: false,
    shoulderTiltDeg: 0,
    shouldersSquare: false,
    bodyCropSafety: 'safe',
    kneesVisible: false,
    anklesVisible: false,
  };
  if (!poseResult?.landmarks?.length) return empty;

  const lm = poseResult.landmarks[0]; // normalized {x, y, z, visibility}
  const vis = (idx) => (lm[idx]?.visibility ?? 0) > 0.5;

  // Shoulder tilt (degrees)
  let shoulderTiltDeg = 0;
  let shouldersSquare = false;
  if (vis(PL.L_SHOULDER) && vis(PL.R_SHOULDER)) {
    const dy = lm[PL.L_SHOULDER].y - lm[PL.R_SHOULDER].y;
    const dx = lm[PL.L_SHOULDER].x - lm[PL.R_SHOULDER].x;
    shoulderTiltDeg = Math.atan2(dy, dx) * 180 / Math.PI;
    // Check if shoulders are square (facing camera straight on)
    // When square, both shoulders are at similar z-depth
    const dz = Math.abs((lm[PL.L_SHOULDER].z ?? 0) - (lm[PL.R_SHOULDER].z ?? 0));
    shouldersSquare = dz < 0.03;
  }

  // Body crop safety — check what joints are near the frame edge
  let bodyCropSafety = 'safe';
  const bottomY = (idx) => vis(idx) ? lm[idx].y : null;

  const kneeY = Math.max(bottomY(PL.L_KNEE) ?? 0, bottomY(PL.R_KNEE) ?? 0);
  const ankleY = Math.max(bottomY(PL.L_ANKLE) ?? 0, bottomY(PL.R_ANKLE) ?? 0);
  const wristY = Math.max(bottomY(PL.L_WRIST) ?? 0, bottomY(PL.R_WRIST) ?? 0);

  // Check if joints are near the bottom edge (within 5% of frame)
  if (vis(PL.L_KNEE) || vis(PL.R_KNEE)) {
    if (kneeY > 0.92 && kneeY < 1.0) bodyCropSafety = 'knee-crop';
  }
  if (vis(PL.L_ANKLE) || vis(PL.R_ANKLE)) {
    if (ankleY > 0.92 && ankleY < 1.0) bodyCropSafety = 'ankle-crop';
  }
  if (vis(PL.L_WRIST) || vis(PL.R_WRIST)) {
    if (wristY > 0.90 && wristY < 1.0 && bodyCropSafety === 'safe') {
      bodyCropSafety = 'wrist-crop';
    }
  }

  return {
    hasPose: true,
    shoulderTiltDeg,
    shouldersSquare,
    bodyCropSafety,
    kneesVisible: vis(PL.L_KNEE) || vis(PL.R_KNEE),
    anklesVisible: vis(PL.L_ANKLE) || vis(PL.R_ANKLE),
  };
}

// ─── Human-readable summary for cloud mode ────────────────────────────────────

function buildHumanReadableSummary(m) {
  const r2d = (r) => (r * 180 / Math.PI).toFixed(1);
  const pct = (v) => (v * 100).toFixed(1) + '%';
  const lines = [
    `Face detected: ${m.faceDetected}`,
    `Image: ${m.imageWidthPx}×${m.imageHeightPx}px`,
    `Head yaw: ${r2d(m.faceYawAngle)}° (${m.viewTypeName})`,
    `Head pitch: ${r2d(m.facePitchAngle)}°  roll: ${r2d(m.faceRollAngle)}°`,
    `Exposure EV: ${m.exposureEV.toFixed(2)}`,
    `Lighting ratio: ${m.lightingRatio.toFixed(2)}:1 (${m.lightingDirection})`,
    `Lighting pattern: ${m.lightingPattern}  broad/short: ${m.lightingBroadShort}`,
    `Catchlight: ${m.hasCatchlights ? `yes, ${m.catchlightClockHour} o'clock` : 'none'}`,
    `Color cast — warmth: ${m.colorCastWarmth.toFixed(3)}  green shift: ${m.colorCastGreenShift.toFixed(3)}`,
    `Skin smoothness: ${m.skinSmoothness.toFixed(3)}`,
    `Face quality (sharpness): ${m.faceQualityScore.toFixed(3)}`,
    `Left eye sharpness: ${m.leftEyeSharpness.toFixed(3)}  right: ${m.rightEyeSharpness.toFixed(3)}`,
    `Near-eye sharpness: ${m.nearEyeSharpness.toFixed(3)}`,
    `Face framing: ${pct(m.faceFramingRatio)} of frame`,
    `Eyeline Y: ${m.eyelineYPosition.toFixed(3)}  horizontal offset: ${m.horizontalOffset.toFixed(3)}`,
    `Headroom ratio: ${m.headroomRatio.toFixed(3)}  crop safety: ${m.cropLineSafety}`,
    `Lead-room violation: ${m.leadRoomViolation}`,
    `Background brightness: ${m.backgroundBrightness.toFixed(3)}`,
    `Squinch ratio: ${m.squinchRatio.toFixed(3)}  squinching: ${m.isSquinching}  wide-eyed: ${m.isWideEyed}`,
    `Inferior scleral show: ${m.inferiorScleralShow.toFixed(3)}`,
    `Smiling: ${m.isSmiling}  Duchenne: ${m.isDuchenneSmile}`,
    `Lip gap ratio: ${m.lipGapRatio.toFixed(4)}`,
  ];
  return lines.join('\n');
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function analyzeImage(file) {
  const { face: fl, pose: pl } = await loadMediaPipe();
  const { canvas, ctx, w, h } = await drawToCanvas(file);

  // Run MediaPipe face + pose detection
  const result = fl.detect(canvas);
  let poseResult = null;
  try { if (pl) poseResult = pl.detect(canvas); } catch (_) { /* pose is optional */ }

  if (!result.faceLandmarks?.length) {
    // Retry at half resolution — face detection can work better at lower res
    let retryResult = null;
    const halfW = Math.round(w / 2), halfH = Math.round(h / 2);
    if (halfW >= 200 && halfH >= 200) {
      const retryCanvas = document.createElement('canvas');
      retryCanvas.width = halfW; retryCanvas.height = halfH;
      const retryCtx = retryCanvas.getContext('2d');
      retryCtx.drawImage(canvas, 0, 0, halfW, halfH);
      retryResult = fl.detect(retryCanvas);
      if (retryResult.faceLandmarks?.length) {
        // Use the retry result but keep original canvas for pixel analysis
        clearImageData(retryCanvas, retryCtx);
      } else {
        clearImageData(retryCanvas, retryCtx);
        retryResult = null;
      }
    }

    if (!retryResult) {
      const debugW = w, debugH = h;
      clearImageData(canvas, ctx);
      return {
        faceDetected: false,
        imageWidthPx: debugW,
        imageHeightPx: debugH,
        _debug: { canvasW: debugW, canvasH: debugH },
      };
    }
    // Use retry landmarks with original canvas
    result = retryResult;
  }

  const landmarks    = result.faceLandmarks[0];        // array of {x,y,z} normalized
  const blendshapes  = result.faceBlendshapes?.[0]?.categories ?? [];
  const matrix       = result.facialTransformationMatrixes?.[0];

  const pose = matrix ? extractHeadPose(matrix) : { pitch: 0, yaw: 0, roll: 0 };
  const faceRect = faceBBox(landmarks, w, h);

  // Eye centers (normalized coords)
  const rightIris = landmarks[468];
  const leftIris  = landmarks[473];

  // Sharpness
  const faceQualityScore = laplacianVariance(ctx, faceRect.x, faceRect.y, faceRect.width, faceRect.height);
  const rightEyeSharpness = eyeRegionSharpness(ctx, rightIris.x, rightIris.y, w, h);
  const leftEyeSharpness  = eyeRegionSharpness(ctx, leftIris.x,  leftIris.y,  w, h);
  const yawDeg = pose.yaw * 180 / Math.PI;
  const nearEyeSharpness = Math.abs(yawDeg) > 10
    ? (pose.yaw > 0 ? rightEyeSharpness : leftEyeSharpness)
    : Math.max(leftEyeSharpness, rightEyeSharpness);

  // Exposure
  const exposureEV = computeExposureEV(ctx, w, h);

  // Lighting
  const { ratio: lightingRatio, direction: lightingDirection } = computeLightingRatio(ctx, faceRect, w, h);

  // Sunglasses detection
  const eyesObscured = isEyeRegionDark(ctx, rightIris.x, rightIris.y, w, h)
                    && isEyeRegionDark(ctx, leftIris.x, leftIris.y, w, h);

  // Catchlight (use right iris — typically camera-near in 3/4 view)
  const catchL = detectCatchlight(ctx, rightIris.x, rightIris.y, w, h);
  const catchlightClockHour = catchL.clockHour;
  const hasCatchlights = catchL.detected;
  const lightingPattern = classifyLightingPattern(lightingRatio, catchlightClockHour);
  const lightingBroadShort = broadVsShort(pose.yaw, lightingDirection);

  // Color & smoothness
  const cc = detectColorCast(ctx, faceRect);
  const skinSmoothness = computeSkinSmoothness(ctx, faceRect);

  // Composition — scale bbox to approximate head area (face oval bbox covers
  // forehead-to-chin and cheek-to-cheek; the "head" including hair/jaw is
  // roughly 1.35x wide and 1.5x tall relative to the oval bbox).
  const headW = faceRect.width  * 1.35;
  const headH = faceRect.height * 1.50;
  const faceFramingRatio = (headW * headH) / (w * h);

  const eyeAvgY = (rightIris.y + leftIris.y) / 2;
  const eyelineYPosition  = eyeAvgY;
  const eyeAvgX = (rightIris.x + leftIris.x) / 2;
  const horizontalOffset  = (eyeAvgX - 0.5) * 2;

  const headroomRatio = computeHeadroomRatio(landmarks);
  const cropLineSafety = computeCropLineSafety(faceRect, h);
  const leadRoomViolation = computeLeadRoomViolation(pose.yaw, horizontalOffset);
  const vTypeName = viewTypeName(yawDeg);

  // Background brightness
  const backgroundBrightness = computeBackgroundBrightness(ctx, faceRect, w, h);

  // Eye expression
  const squinchData = blendshapes.length
    ? computeSquinchFromBlendshapes(blendshapes)
    : computeSquinchFromLandmarks(landmarks);

  const duchenneData = blendshapes.length
    ? computeDuchenneSmile(blendshapes)
    : { isSmiling: false, isDuchenne: false, mouthSmile: 0, eyeCrinkle: 0 };

  const irisData = computeIrisToScleraRatio(landmarks, w, h);
  const lipData  = computeLipGap(landmarks, (faceRect.height / h));

  // Subject isolation (background blur)
  const isolation = computeSubjectIsolation(ctx, faceRect, w, h);

  // Face tonal range
  const tonalRange = computeFaceTonalRange(ctx, faceRect);

  // Expression tension
  const tension = computeExpressionTension(blendshapes);

  // Body pose
  const bodyPose = analyzeBodyPose(poseResult, h);

  // Privacy cleanup
  clearImageData(canvas, ctx);

  const metrics = {
    faceDetected: true,
    faceBoundingBox: faceRect,
    faceYawAngle:   pose.yaw,
    facePitchAngle: pose.pitch,
    faceRollAngle:  pose.roll,
    leftEyeCenter:  { x: leftIris.x,  y: leftIris.y  },
    rightEyeCenter: { x: rightIris.x, y: rightIris.y },
    imageWidthPx:  w,
    imageHeightPx: h,

    // Lighting
    faceQualityScore,
    exposureEV,
    hasCatchlights,
    catchlightPositions: hasCatchlights ? [`${catchlightClockHour} o'clock`] : [],
    lightingRatio,
    lightingDirection,
    backgroundBrightness,
    catchlightClockHour,
    lightingPattern,
    lightingBroadShort,
    colorCastWarmth:     cc.warmth,
    colorCastGreenShift: cc.greenShift,
    isGreenCast:  cc.isGreenCast,
    isCoolCast:   cc.isCoolCast,
    skinSmoothness,

    // Composition
    faceFramingRatio,
    eyelineYPosition,
    horizontalOffset,
    headroomRatio,
    cropLineSafety,
    leadRoomViolation,
    viewTypeName: vTypeName,

    // Sharpness
    leftEyeSharpness,
    rightEyeSharpness,
    nearEyeSharpness,

    // Eyes & expression
    squinchRatio: squinchData.ratio,
    isSquinching: squinchData.isSquinching,
    isWideEyed:   squinchData.isWideEyed,
    irisToScleraRatio:   irisData.coverage,
    inferiorScleralShow: irisData.inferiorScleral,
    isSmiling:       duchenneData.isSmiling,
    isDuchenneSmile: duchenneData.isDuchenne,
    lipGapRatio: lipData.ratio,
    eyesObscured,

    // Subject isolation
    subjectIsolationRatio: isolation.ratio,

    // Face tonal range
    highlightClipPct: tonalRange.highlightClipPct,
    shadowClipPct:    tonalRange.shadowClipPct,

    // Expression tension
    browTension:  tension.browTension,
    jawTension:   tension.jawTension,
    hasTension:   tension.hasTension,

    // Body pose (from PoseLandmarker)
    hasPose:          bodyPose.hasPose,
    shoulderTiltDeg:  bodyPose.shoulderTiltDeg,
    shouldersSquare:  bodyPose.shouldersSquare,
    bodyCropSafety:   bodyPose.bodyCropSafety,
    kneesVisible:     bodyPose.kneesVisible,
    anklesVisible:    bodyPose.anklesVisible,
  };

  metrics.humanReadableSummary = buildHumanReadableSummary(metrics);
  return metrics;
}
