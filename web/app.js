/**
 * app.js — OnFrame SPA state machine
 */

import { loadMediaPipe, analyzeImage } from './analysis.js';
import { synthesize } from './synthesizer.js';
import { fetchCloudCoaching } from './cloud.js';
import { mergeCoachingResult } from './merge.js';
import { isMobileDevice } from './device.js';

// Mobile-only gate. Inline <script> in index.html applies this class
// synchronously to prevent flash; this re-applies it from the canonical
// device.js source so the two checks can't drift.
if (!isMobileDevice()) {
  document.documentElement.classList.add('is-desktop');
}

// ─── State ────────────────────────────────────────────────────────────────────

let currentThumbUrl = null;
let activeAnalysisToken = 0;
let lastMetrics = null;
let lastResult = null;
let lastError = null;
let lastFileInfo = null;
const BASE_URL = import.meta.env.BASE_URL || '/';
const APP_BASE_URL = BASE_URL.replace(/\/+$/, '');
const REPORT_URL = `${APP_BASE_URL}/api/report`;

function formatErrorMessage(err, fallback = 'Something went wrong') {
  if (err instanceof Error && err.message && err.message !== '[object Event]') {
    return err.message;
  }
  if (typeof Event !== 'undefined' && err instanceof Event) {
    const target = err.target || err.currentTarget;
    const src = target?.src || target?.currentSrc || target?.href;
    return src ? `${fallback}: failed to load ${src}` : fallback;
  }
  if (typeof err === 'string' && err.trim()) return err;
  return fallback;
}

function clearAnalysisState() {
  lastMetrics = null;
  lastResult = null;
  lastError = null;
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const uploadZone    = document.getElementById('upload-zone');
const fileInput     = document.getElementById('file-input');
const cameraInput   = document.getElementById('camera-input');
const analyzingPanel= document.getElementById('analyzing-panel');
const analyzingLabel= document.getElementById('analyzing-label');
const resultsPanel  = document.getElementById('results-panel');
const errorPanel    = document.getElementById('error-panel');
const errorMsg      = document.getElementById('error-msg');
const photoThumb    = document.getElementById('photo-thumb');
const overallNum    = document.getElementById('overall-num');
const cardCarousel  = document.getElementById('card-carousel');
const carouselDots  = document.getElementById('carousel-dots');
const aiSummaryBox  = document.getElementById('ai-summary-box');
const aiSummaryText = document.getElementById('ai-summary-text');
const sampleImageUrls = {
  'sample1.jpg':  new URL('./sample/sample1.jpg',  import.meta.url).href,
  'sample2.jpg':  new URL('./sample/sample2.jpg',  import.meta.url).href,
  'sample3.jpg':  new URL('./sample/sample3.jpg',  import.meta.url).href,
  'sample4.jpg':  new URL('./sample/sample4.jpg',  import.meta.url).href,
  'sample5.jpg':  new URL('./sample/sample5.jpg',  import.meta.url).href,
  'sample6.jpg':  new URL('./sample/sample6.jpg',  import.meta.url).href,
  'sample7.jpg':  new URL('./sample/sample7.jpg',  import.meta.url).href,
  'sample8.jpg':  new URL('./sample/sample8.jpg',  import.meta.url).href,
  'sample9.jpg':  new URL('./sample/sample9.jpg',  import.meta.url).href,
  'sample10.jpg': new URL('./sample/sample10.jpg', import.meta.url).href,
  'sample11.jpg': new URL('./sample/sample11.jpg', import.meta.url).href,
  'sample12.jpg': new URL('./sample/sample12.jpg', import.meta.url).href,
};
// ─── Upload handlers ──────────────────────────────────────────────────────────

document.getElementById('btn-choose')?.addEventListener('click', (e) => {
  e.stopPropagation();
  fileInput.value = '';   // reset so re-selecting same file triggers change
  fileInput?.click();
});
document.getElementById('btn-camera')?.addEventListener('click', (e) => {
  e.stopPropagation();
  cameraInput.value = ''; // reset so re-taking a photo triggers change
  cameraInput?.click();
});

uploadZone?.addEventListener('click', (e) => {
  if (e.target.tagName !== 'BUTTON' && !e.target.closest('.sample-gallery')) fileInput?.click();
});

uploadZone?.addEventListener('dragover', (e) => {
  e.preventDefault(); uploadZone.classList.add('drag-over');
});
uploadZone?.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone?.addEventListener('drop', (e) => {
  e.preventDefault(); uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});

fileInput?.addEventListener('change', () => {
  if (fileInput.files?.[0]) handleFile(fileInput.files[0]);
});
cameraInput?.addEventListener('change', () => {
  if (cameraInput.files?.[0]) handleFile(cameraInput.files[0]);
});

document.querySelector('.btn-retry')?.addEventListener('click', reset);

// ─── Sample gallery ──────────────────────────────────────────────────────────

const sampleThumbs = document.getElementById('sample-thumbs');

async function loadSample(filename) {
  try {
    const sampleUrl = sampleImageUrls[filename];
    if (!sampleUrl) throw new Error(`Unknown sample: ${filename}`);
    const res = await fetch(sampleUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    handleFile(new File([blob], filename, { type: blob.type || 'image/jpeg' }));
  } catch (err) {
    showError('Could not load sample photo: ' + formatErrorMessage(err, 'sample photo load failed'));
  }
}

sampleThumbs?.addEventListener('click', (e) => {
  e.stopPropagation();
  const thumb = e.target.closest('.sample-thumb');
  if (!thumb) return;
  sampleThumbs.querySelectorAll('.sample-thumb').forEach(t => t.classList.remove('active'));
  thumb.classList.add('active');
  loadSample(thumb.dataset.sample);
});

// ─── Main flow ────────────────────────────────────────────────────────────────

let isAnalyzing = false;

async function handleFile(file) {
  if (isAnalyzing) return;
  if (file.type && !file.type.startsWith('image/')) {
    showError('Please select an image file (JPG, PNG, HEIC, etc.)');
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    showError('Photo is too large (max 20 MB). Try a smaller file or resize it first.');
    return;
  }

  isAnalyzing = true;
  clearAnalysisState();
  lastFileInfo = {
    size: file.size,
    type: file.type || 'unknown',
    name: file.name ? file.name.replace(/.*[/\\]/, '').slice(-20) : 'unknown',
  };
  const analysisToken = ++activeAnalysisToken;
  showState('analyzing');
  analyzingLabel.textContent = 'Analyzing your photo…';

  let currentStage = 'init';
  try {
    let metrics;
    currentStage = 'analyzeImage';
    try {
      metrics = await analyzeImage(file);
    } catch (err) {
      if (analysisToken !== activeAnalysisToken) return;
      const message = formatErrorMessage(err, 'analysis failed');
      lastError = { stage: 'analyzeImage', message, stack: err?.stack?.slice(0, 300), fileInfo: lastFileInfo };
      console.error('[onframe] analyzeImage error:', err);
      showError('Analysis failed: ' + message);
      return;
    }

    if (analysisToken !== activeAnalysisToken) return;
    lastMetrics = metrics;

    currentStage = 'faceDetection';
    if (!metrics.faceDetected) {
      lastError = {
        stage: 'faceDetection',
        message: 'no face found',
        fileInfo: lastFileInfo,
        imageSize: [metrics.imageWidthPx, metrics.imageHeightPx],
        debug: metrics._debug,
      };
      showError(`No face found (${metrics.imageWidthPx}x${metrics.imageHeightPx}px). Try a photo where the face is well-lit, facing the camera, and not too far away.`);
      return;
    }

    currentStage = 'synthesize';
    const result = synthesize(metrics);

    currentStage = 'cloudCoaching';
    analyzingLabel.textContent = 'Asking AI for coaching…';
    const cloudPayload = {
      summary: metrics.humanReadableSummary,
      photoType: result.photoType?.type ?? null,
      localScores: Object.fromEntries(
        (result.cards || []).map((c) => [c.category, c.score])
      ),
      localCards: (result.cards || []).map((c) => ({
        category: c.category,
        score: c.score,
        title: c.title,
        priority: c.priority,
      })),
    };
    const cloudResponse = await fetchCloudCoaching(file, cloudPayload);
    const mergedResult = mergeCoachingResult(result, cloudResponse);

    if (analysisToken !== activeAnalysisToken) return;

    // Store for report button
    lastResult = mergedResult;

    currentStage = 'renderResults';
    renderResults(file, mergedResult, mergedResult.aiSummary || null);
    showState('complete', true);
  } catch (err) {
    if (analysisToken !== activeAnalysisToken) return;
    const message = formatErrorMessage(err, 'unexpected error');
    lastError = { stage: currentStage, message, stack: err?.stack?.slice(0, 300), fileInfo: lastFileInfo };
    console.error(`[onframe] error in ${currentStage}:`, err);
    showError(`Something went wrong during ${currentStage}: ${message}`);
  } finally {
    if (analysisToken === activeAnalysisToken) {
      isAnalyzing = false;
    }
  }
}

// ─── Pin positioning utilities ───────────────────────────────────────────────

const PIN_LABELS = {
  'Lighting':              'Light',
  'Head Angle & Pose':     'Pose',
  'Composition & Framing': 'Frame',
  'Sharpness & Focus':     'Focus',
  'Background':            'Scene',
  'Eye Contact & Gaze':    'Eyes',
};

const PRIORITY_LABELS = {
  1: 'Fix now',
  2: 'Improve',
  3: 'Working',
};

// Returns { anchor: {x,y}, label: {x,y} } for each category.
// anchor = point on the face the line points to
// label  = where the pin sits (outside the face)
function getPinPositions(metrics) {
  if (!metrics || !metrics.faceDetected) return {};
  const fb = metrics.faceBoundingBox;
  const imgW = metrics.imageWidthPx;
  const imgH = metrics.imageHeightPx;
  const faceCX = (fb.x + fb.width / 2) / imgW;
  const faceCY = (fb.y + fb.height / 2) / imgH;
  const eyeMidX = (metrics.leftEyeCenter.x + metrics.rightEyeCenter.x) / 2;
  const eyeMidY = (metrics.leftEyeCenter.y + metrics.rightEyeCenter.y) / 2;
  // Place pins on the opposite side of the face from center
  const faceLeft = faceCX < 0.5;

  // Pin side: place on opposite side of face. Avoid top-left (back button zone).
  const pinSide = faceLeft ? 0.92 : 0.08;
  const altSide = faceLeft ? 0.08 : 0.92;
  // If alt side is top-left (x<0.15), push pins to the right side instead
  const safeSide = altSide < 0.15 ? 0.92 : altSide;

  return distributePinLabels({
    'Lighting': {
      anchor: { x: faceCX, y: faceCY },
      label:  { x: pinSide, y: faceCY - 0.04 },
    },
    'Head Angle & Pose': {
      anchor: { x: faceCX, y: Math.max(0.05, fb.y / imgH) },
      label:  { x: pinSide, y: 0.14 },
    },
    'Composition & Framing': {
      anchor: { x: eyeMidX, y: eyeMidY - 0.03 },
      label:  { x: safeSide, y: 0.14 },
    },
    'Sharpness & Focus': {
      // Anchor to cheek area below eyes, not on the eyes
      anchor: { x: faceCX + (faceLeft ? 0.03 : -0.03), y: faceCY + 0.05 },
      label:  { x: pinSide, y: faceCY + 0.10 },
    },
    'Background': {
      anchor: { x: faceLeft ? 0.85 : 0.15, y: 0.15 },
      label:  { x: safeSide, y: 0.26 },
    },
    'Eye Contact & Gaze': {
      // Anchor to forehead/brow area, not directly on eyes
      anchor: { x: eyeMidX, y: eyeMidY - 0.06 },
      label:  { x: pinSide, y: eyeMidY - 0.14 },
    },
  });
}

function distributePinLabels(rawPositions) {
  const positions = Object.fromEntries(
    Object.entries(rawPositions).map(([category, pos]) => [category, {
      anchor: { ...pos.anchor },
      label: { ...pos.label },
    }])
  );

  for (const side of ['left', 'right']) {
    const entries = Object.entries(positions)
      .filter(([, pos]) => (side === 'left' ? pos.label.x < 0.5 : pos.label.x >= 0.5))
      .sort((a, b) => a[1].label.y - b[1].label.y);
    const minGap = 0.115;
    const minY = 0.12;
    const maxY = 0.88;
    let prevY = minY - minGap;

    for (const [, pos] of entries) {
      pos.label.y = Math.max(minY, Math.min(maxY, pos.label.y));
      if (pos.label.y - prevY < minGap) {
        pos.label.y = Math.min(maxY, prevY + minGap);
      }
      prevY = pos.label.y;
    }

    for (let i = entries.length - 2; i >= 0; i--) {
      const current = entries[i][1].label;
      const next = entries[i + 1][1].label;
      if (next.y - current.y < minGap) {
        current.y = Math.max(minY, next.y - minGap);
      }
    }
  }

  return positions;
}

function getImageDisplayRect(imgEl) {
  const cW = imgEl.clientWidth, cH = imgEl.clientHeight;
  const nW = imgEl.naturalWidth, nH = imgEl.naturalHeight;
  if (!nW || !nH) return { offsetX: 0, offsetY: 0, displayW: cW, displayH: cH };
  const scale = Math.min(cW / nW, cH / nH);
  const dW = nW * scale, dH = nH * scale;
  return { offsetX: (cW - dW) / 2, offsetY: (cH - dH) / 2, displayW: dW, displayH: dH };
}

function normToPixel(normX, normY, imgEl) {
  const { offsetX, offsetY, displayW, displayH } = getImageDisplayRect(imgEl);
  return {
    px: offsetX + normX * displayW,
    py: offsetY + normY * displayH,
  };
}

function normToPercent(normX, normY, imgEl) {
  const { px, py } = normToPixel(normX, normY, imgEl);
  return {
    left: (px / imgEl.clientWidth * 100) + '%',
    top:  (py / imgEl.clientHeight * 100) + '%',
  };
}

// ─── Carousel state ──────────────────────────────────────────────────────────

let activeCardIndex = 0;
let sortedCards = [];
let pinElements = {};
let cardElements = {};
let resizeObserver = null;

function updateActiveCard(index) {
  activeCardIndex = index;
  const category = sortedCards[index]?.category;
  setActiveCategory(category);
}

function setActiveCategory(category) {
  if (!category) return;
  Object.values(pinElements).forEach(p => p.classList.remove('active'));
  Object.values(cardElements).forEach(c => c.classList.remove('active'));
  if (pinElements[category]) pinElements[category].classList.add('active');
  if (cardElements[category]) cardElements[category].classList.add('active');
  if (carouselDots) {
    carouselDots.querySelectorAll('.carousel-dot').forEach(d => {
      d.classList.toggle('active', d.dataset.category === category);
    });
  }
  activeCardIndex = Math.max(0, sortedCards.findIndex((card) => card.category === category));
}

function activateCategory(category) {
  setActiveCategory(category);
  const card = cardElements[category];
  if (!card || !cardCarousel) return;
  // Align the chosen card to the carousel's left edge so snap is consistent
  // with the start-aligned layout. Padding handles visual breathing room.
  const padLeft = parseFloat(getComputedStyle(cardCarousel).paddingLeft) || 0;
  cardCarousel.scrollTo({ left: card.offsetLeft - padLeft, behavior: 'smooth' });
}

function makeCardInteractive(el, category) {
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', `Open coaching for ${category}`);
  el.addEventListener('click', () => activateCategory(category));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activateCategory(category);
    }
  });
}

function buildCardElement(card, compact = false) {
  const el = document.createElement('article');
  const severityClass = scoreClass(card.score);
  const priorityLabel = PRIORITY_LABELS[card.priority] || 'Note';

  // One score + one text per card. When the photo-specific observation is
  // available, prepend it to the generic actionable tip so the user gets
  // both 'what's wrong with this photo' and 'how to fix it' in one sentence.
  const text = card.aiReason
    ? `${card.aiReason} — ${card.tip}`
    : card.tip;

  el.className = `card ${compact ? 'card-compact' : 'card-primary'} ${severityClass}`;
  el.dataset.category = card.category;
  el.innerHTML = `
    <div class="card-topline">
      <span class="card-cat">${escapeHtml(card.category)}</span>
      <span class="card-priority priority-${card.priority}">${priorityLabel}</span>
    </div>
    <div class="card-header">
      <span class="card-score ${severityClass}">${card.score}</span>
    </div>
    <div class="card-bar">
      <div class="score-bar-track">
        <div class="score-bar-fill ${barClass(card.score)}" style="width:${card.score}%"></div>
      </div>
    </div>
    <div class="card-body">
      <p class="card-tip">${escapeHtml(text)}</p>
    </div>
  `;

  makeCardInteractive(el, card.category);
  return el;
}

// ─── Render results ───────────────────────────────────────────────────────────

function renderResults(file, result, aiSummary) {
  // Thumbnail
  if (currentThumbUrl) {
    URL.revokeObjectURL(currentThumbUrl);
    currentThumbUrl = null;
  }
  const blobUrl = URL.createObjectURL(file);
  currentThumbUrl = blobUrl;
  photoThumb.src = blobUrl;
  photoThumb.onload = () => {
    renderPins();
    if (currentThumbUrl === blobUrl) currentThumbUrl = null;
    URL.revokeObjectURL(blobUrl);
  };
  photoThumb.onerror = () => {
    if (currentThumbUrl === blobUrl) currentThumbUrl = null;
    URL.revokeObjectURL(blobUrl);
  };

  // Overall score
  overallNum.textContent = result.overallScore;
  overallNum.className = scoreClass(result.overallScore);

  // Photo type
  const typeLabel = document.getElementById('photo-type-label');
  if (typeLabel && result.photoType) {
    typeLabel.textContent = result.photoType.label;
  }

  // Top-level coaching summary — no label, just the text. The lead sentence
  // is the most-important observation; treat it as the headline of the read.
  if (aiSummaryBox && aiSummaryText) {
    const text = aiSummary || result.summary || '';
    if (text) {
      aiSummaryText.textContent = text;
      aiSummaryBox.style.display = 'block';
    } else {
      aiSummaryBox.style.display = 'none';
    }
  }

  // AI unavailable banner — shown when cloud coaching failed and we're
  // serving the local synthesizer's cards as a degraded fallback.
  const aiUnavailableBanner = document.getElementById('ai-unavailable-banner');
  if (aiUnavailableBanner) {
    aiUnavailableBanner.style.display = result.aiUnavailable ? 'block' : 'none';
  }

  // Worst score first so the user sees the most-pressing fix when the
  // carousel opens.
  sortedCards = [...result.cards].sort((a, b) => a.score - b.score);

  cardElements = {};
  cardCarousel.innerHTML = '';
  carouselDots.innerHTML = '';

  for (const card of sortedCards) {
    const el = buildCardElement(card, false);
    cardCarousel.appendChild(el);
    cardElements[card.category] = el;

    const dot = document.createElement('span');
    dot.className = 'carousel-dot';
    dot.dataset.category = card.category;
    carouselDots.appendChild(dot);
  }

  // Reset scroll to the first (worst-scoring) card. Run after layout via
  // rAF so scroll-snap doesn't settle on a different card mid-render.
  updateActiveCard(0);
  requestAnimationFrame(() => {
    cardCarousel.scrollLeft = 0;
    observeCarousel();
  });
}

// ─── Carousel observer ───────────────────────────────────────────────────────

let carouselObserver = null;

function observeCarousel() {
  if (carouselObserver) carouselObserver.disconnect();
  if (!cardCarousel || typeof IntersectionObserver === 'undefined') return;

  carouselObserver = new IntersectionObserver((entries) => {
    // Pick the entry closest to fully visible.
    let best = null;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      if (!best || entry.intersectionRatio > best.intersectionRatio) best = entry;
    }
    if (!best) return;
    const category = best.target.dataset.category;
    if (category) setActiveCategory(category);
  }, {
    root: cardCarousel,
    threshold: [0.55, 0.75, 0.95],
  });

  for (const card of Object.values(cardElements)) carouselObserver.observe(card);
}

// ─── Pin rendering ───────────────────────────────────────────────────────────

let lineElements = {};

function positionPinAndLine(category, pos, card, imgEl) {
  const pin = pinElements[category];
  if (!pin || !pos) return;

  const labelPos = normToPercent(pos.label.x, pos.label.y, imgEl);
  pin.style.left = labelPos.left;
  pin.style.top = labelPos.top;
}

function renderPins() {
  const pinsContainer = document.getElementById('hotspot-pins');
  pinsContainer.innerHTML = '';
  pinElements = {};
  lineElements = {};

  const positions = getPinPositions(lastMetrics);
  if (!Object.keys(positions).length) return;

  for (const card of sortedCards) {
    const pos = positions[card.category];
    if (!pos) continue;

    const pin = document.createElement('button');
    const pinClass = card.score >= 75 ? 'pin-great' : card.score >= 55 ? 'pin-ok' : 'pin-poor';
    pin.className = `hotspot-pin ${pinClass}`;
    pin.type = 'button';
    pin.textContent = PIN_LABELS[card.category] || '•';
    pin.setAttribute('aria-label', `${card.category}: ${card.title}`);

    pinElements[card.category] = pin;
    positionPinAndLine(card.category, pos, card, photoThumb);

    pin.addEventListener('click', () => activateCategory(card.category));

    pinsContainer.appendChild(pin);
  }

  // Mark first card's pin as active
  if (sortedCards[0] && pinElements[sortedCards[0].category]) {
    pinElements[sortedCards[0].category].classList.add('active');
  }

  // Reposition on resize
  if (resizeObserver) resizeObserver.disconnect();
  const wrap = document.querySelector('.photo-overlay-wrap');
  if (wrap) {
    resizeObserver = new ResizeObserver(() => {
      for (const card of sortedCards) {
        const pos = positions[card.category];
        if (pos) positionPinAndLine(card.category, pos, card, photoThumb);
      }
    });
    resizeObserver.observe(wrap);
  }
}

// ─── Bottom sheet drag ───────────────────────────────────────────────────────

(function initBottomSheet() {
  const sheet = document.getElementById('bottom-sheet');
  const handle = document.getElementById('sheet-handle');
  const header = document.querySelector('.sheet-header');
  if (!sheet || !handle) return;

  const SNAP_COLLAPSED = 55;
  const SNAP_HALF = 32;
  const SNAP_FULL = 6;

  let startY = 0, startTop = 0, isDragging = false;

  function onStart(clientY) {
    isDragging = true;
    startY = clientY;
    startTop = sheet.getBoundingClientRect().top;
    sheet.classList.add('dragging');
  }
  function onMove(clientY) {
    if (!isDragging) return;
    const delta = clientY - startY;
    const newTop = Math.max(
      window.innerHeight * SNAP_FULL / 100,
      Math.min(window.innerHeight * SNAP_COLLAPSED / 100, startTop + delta)
    );
    sheet.style.top = newTop + 'px';
  }
  function onEnd() {
    if (!isDragging) return;
    isDragging = false;
    sheet.classList.remove('dragging');

    const currentTop = sheet.getBoundingClientRect().top;
    const vh = currentTop / window.innerHeight * 100;

    const snaps = [SNAP_FULL, SNAP_HALF, SNAP_COLLAPSED];
    const closest = snaps.reduce((a, b) =>
      Math.abs(b - vh) < Math.abs(a - vh) ? b : a
    );

    sheet.classList.remove('snap-half', 'snap-full');
    sheet.style.top = '';
    if (closest === SNAP_HALF) sheet.classList.add('snap-half');
    else if (closest === SNAP_FULL) sheet.classList.add('snap-full');
  }

  // Make both handle AND header draggable for easier touch targets
  for (const el of [handle, header]) {
    if (!el) continue;
    el.addEventListener('touchstart', (e) => onStart(e.touches[0].clientY), { passive: true });
    el.addEventListener('touchmove', (e) => onMove(e.touches[0].clientY), { passive: true });
    el.addEventListener('touchend', onEnd);

    el.addEventListener('mousedown', (e) => {
      onStart(e.clientY);
      const moveHandler = (ev) => onMove(ev.clientY);
      const upHandler = () => { onEnd(); document.removeEventListener('mousemove', moveHandler); document.removeEventListener('mouseup', upHandler); };
      document.addEventListener('mousemove', moveHandler);
      document.addEventListener('mouseup', upHandler);
    });
  }
})();

// ─── State helpers ────────────────────────────────────────────────────────────

function showState(state, pushHistory = false) {
  uploadZone.style.display    = state === 'idle'      ? 'block' : 'none';
  analyzingPanel.style.display= state === 'analyzing' ? 'block' : 'none';
  resultsPanel.style.display  = state === 'complete'  ? 'flex' : 'none';
  errorPanel.style.display    = state === 'error'     ? 'block' : 'none';
  // Hide nav when results overlay is shown
  const nav = document.querySelector('nav');
  if (nav) nav.style.display = state === 'complete' ? 'none' : '';
  if (pushHistory) {
    history.pushState({ view: state }, '');
  }
}

// When user goes back, reset and replace state so forward doesn't re-show results
window.addEventListener('popstate', () => {
  reset();
  history.replaceState({ view: 'idle' }, '');
});

function showError(msg) {
  errorMsg.textContent = msg;
  showState('error');
}

function reset() {
  activeAnalysisToken++;
  isAnalyzing = false;
  clearAnalysisState();
  fileInput.value = '';
  cameraInput.value = '';
  if (currentThumbUrl) {
    URL.revokeObjectURL(currentThumbUrl);
    currentThumbUrl = null;
  }
  photoThumb.onload = null;
  photoThumb.onerror = null;
  photoThumb.src = '';
  if (cardCarousel) cardCarousel.innerHTML = '';
  if (carouselDots) carouselDots.innerHTML = '';
  if (carouselObserver) { carouselObserver.disconnect(); carouselObserver = null; }
  overallNum.textContent = '—';
  overallNum.className = '';
  const typeLabel = document.getElementById('photo-type-label');
  if (typeLabel) typeLabel.textContent = '';
  if (aiSummaryBox) aiSummaryBox.style.display = 'none';
  if (aiSummaryText) aiSummaryText.textContent = '';
  const aiUnavailableBanner = document.getElementById('ai-unavailable-banner');
  if (aiUnavailableBanner) aiUnavailableBanner.style.display = 'none';
  // Clear pins and sheet state
  document.getElementById('hotspot-pins').innerHTML = '';
  const sheet = document.getElementById('bottom-sheet');
  if (sheet) {
    sheet.classList.remove('snap-half', 'snap-full');
    sheet.style.top = '';
  }
  pinElements = {};
  cardElements = {};
  lineElements = {};
  sortedCards = [];
  activeCardIndex = 0;
  if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
  showState('idle');
}

// Back button on results overlay
document.getElementById('btn-back-results')?.addEventListener('click', reset);

// ─── Utilities ────────────────────────────────────────────────────────────────

function scoreClass(s) {
  return s >= 75 ? 'score-great' : s >= 55 ? 'score-ok' : 'score-poor';
}
function barClass(s) {
  return s >= 75 ? 'bar-great' : s >= 55 ? 'bar-ok' : 'bar-poor';
}
function escapeHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// ─── Report issue ────────────────────────────────────────────────────────────

function buildReportPayload(userText) {
  const safeMetrics = lastMetrics ? { ...lastMetrics } : null;
  if (safeMetrics) {
    delete safeMetrics.humanReadableSummary;
    delete safeMetrics._debug;
    delete safeMetrics.faceBoundingBox;
    delete safeMetrics.leftEyeCenter;
    delete safeMetrics.rightEyeCenter;
  }
  return {
    id: crypto.randomUUID().slice(0, 8),
    ts: new Date().toISOString(),
    userText: String(userText || '').slice(0, 500),
    context: lastError ? 'error' : 'results',
    error: lastError || { stage: 'unknown', message: 'no error captured' },
    fileInfo: lastFileInfo,
    imageSize: lastMetrics ? [lastMetrics.imageWidthPx, lastMetrics.imageHeightPx] : null,
    faceDetected: lastMetrics?.faceDetected ?? null,
    photoType: lastResult?.photoType ?? null,
    overallScore: lastResult?.overallScore ?? null,
    cardScores: lastResult?.cards?.map(c => ({ cat: c.category, score: c.score })) ?? [],
    metrics: safeMetrics,
    device: {
      ua: navigator.userAgent,
      screen: `${screen.width}x${screen.height}`,
      dpr: devicePixelRatio,
      memory: navigator.deviceMemory || null,
      cores: navigator.hardwareConcurrency || null,
    },
  };
}

async function sendReport(formId, textElId, resultElId) {
  const userText = document.getElementById(textElId)?.value || '';
  const formEl = document.getElementById(formId);
  const resultEl = document.getElementById(resultElId);
  const payload = buildReportPayload(userText);

  try {
    const res = await fetch(REPORT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      let message = `Could not send. Reference ID: ${payload.id}`;
      try {
        const body = await res.json();
        message = body?.error || message;
      } catch (_) {}
      throw new Error(message);
    }
    if (formEl) formEl.style.display = 'none';
    resultEl.textContent = `Sent. Reference ID: ${payload.id}`;
    resultEl.style.color = 'var(--green)';
  } catch (err) {
    resultEl.textContent = `Could not send. Reference ID: ${payload.id}`;
    resultEl.style.color = 'var(--red)';
  }
}

// Results page report
function wireReport(btnId, formId, cancelId, sendId, textId, resultId) {
  document.getElementById(btnId)?.addEventListener('click', () => {
    document.getElementById(formId).style.display = 'block';
    document.getElementById(resultId).textContent = '';
  });
  document.getElementById(cancelId)?.addEventListener('click', () => {
    document.getElementById(formId).style.display = 'none';
  });
  document.getElementById(sendId)?.addEventListener('click', () => sendReport(formId, textId, resultId));
}

wireReport('btn-report', 'report-form', 'btn-report-cancel', 'btn-report-send', 'report-text', 'report-result');

// Auto-expand sheet when report form opens, collapse on cancel
document.getElementById('btn-report')?.addEventListener('click', () => {
  const sheet = document.getElementById('bottom-sheet');
  if (sheet) { sheet.classList.remove('snap-half'); sheet.classList.add('snap-full'); sheet.style.top = ''; }
});
document.getElementById('btn-report-cancel')?.addEventListener('click', () => {
  const sheet = document.getElementById('bottom-sheet');
  if (sheet) { sheet.classList.remove('snap-full'); sheet.classList.add('snap-half'); sheet.style.top = ''; }
});
wireReport('btn-error-report', 'error-report-form', 'btn-error-report-cancel', 'btn-error-report-send', 'error-report-text', 'error-report-result');

// ─── Preload MediaPipe in background ─────────────────────────────────────────

loadMediaPipe().catch(err =>
  console.warn('[onframe] MediaPipe preload failed:', formatErrorMessage(err, 'asset preload failed'))
);
