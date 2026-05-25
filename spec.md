# OnFrame — Specification

> **Note**: this is the original product spec from when the app was called Portrait Coach and used a Groq text-only cloud path. The current architecture is cloud-only with multimodal photo + metrics sent to Vertex AI Gemini — see [`plan.md`](./plan.md) for the source of truth. The sections below are kept for historical context and have been updated where the underlying behavior changed.

---

## 1. Web App

### 1.1 Overview

OnFrame Web — a mobile-only browser-native portrait analysis tool served at `app.gyatso.me/onframe/web/`. No install required. Works in Safari on iPhone, Chrome on Android phones, and iPad Safari. Desktop visitors get a block message.

**Privacy guarantee:**
- Local MediaPipe face/pose analysis runs on-device on canvas pixel data; EXIF metadata is stripped during the canvas decode
- After local analysis: canvas cleared via `ctx.clearRect`, `<img>` src set to `''`, blob URL revoked via `URL.revokeObjectURL`
- No image data written to localStorage, sessionStorage, IndexedDB, cache storage, or any cookie
- The downscaled photo (≤1280px long edge, JPEG, EXIF stripped) + measured metrics are sent to OnFrame's server, forwarded to Vertex AI Gemini in-memory, and discarded immediately after the response. Nothing is written to disk, logged, or retained server-side

---

### 1.2 Architecture

```
User selects photo
      │
      ▼
[Browser: drawToCanvas()]        ← EXIF stripped; original file handle released
      │
      ▼
[Browser: MediaPipe FaceLandmarker]   ← WASM, runs fully locally
      │  478 3D landmarks + 4×4 pose matrix
      ▼
[Browser: Canvas pixel analysis]      ← lighting, sharpness, catchlights
      │
      ▼
[Browser: VisionMetrics object]       ← text/numbers only, no pixels
      │
      ├── [synthesizer.js] computes 6 local card scores (authoritative for cards)
      │     Rules-based, JS port of iOS FeedbackSynthesizer
      │
      └── [downscale.js] re-encodes photo to JPEG ≤1280px, EXIF stripped
            │
            ▼
      [POST /onframe/web/api/analyze]
        multipart: photo (≤6 MB) + metrics JSON (≤16 KB)
            │
      [web-server/server.js: Express + multer.memoryStorage(), port 3004]
      env: VERTEX_PROJECT / VERTEX_LOCATION / VERTEX_MODEL
      · no body logging · no disk writes · buffer nulled after handling
            │
      [Vertex AI Gemini 2.5 Flash — multimodal predict endpoint]
            │
      [JSON: { aiSummary } — Phase 2 will add perceptualFindings deltas]
      │
      ▼
[Browser: clearCanvas(), revoke URLs]   ← privacy cleanup
      │
      ▼
[Render coaching cards]
```

---

### 1.3 Technology Choices

| Concern | Choice | Reason |
|---------|--------|--------|
| Face detection + landmarks | MediaPipe `FaceLandmarker` | 478 3D landmarks, head pose built-in, WASM runs offline |
| Head pose | `facialTransformationMatrixes` decomposition | Direct yaw/pitch/roll from 4×4 matrix |
| Sharpness estimate | Laplacian variance on face region | Best no-library proxy for focus quality |
| Lighting analysis | `getImageData()` + pixel averaging | Equivalent of CoreImage `CIAreaAverage` |
| Catchlight detection | Eye-region pixel threshold scan | Equivalent of `CIColorThreshold` + `CIAreaMinMax` |
| Cloud AI | Vertex AI Gemini 2.5 Flash (multimodal) | Multimodal photo + metrics input; service-account auth from Cloud Run (no API keys in env); perceptual coaching layered on top of deterministic local measurements |
| UI framework | Vanilla JS ES modules + CSS | No build step; consistent with other apps in repo |
| MediaPipe JS runtime | CDN (jsdelivr) | Already allowed in idv-demo CSP pattern |
| MediaPipe model file | Self-hosted (`/onframe/web/models/`) | No third-party requests at analysis time |

---

### 1.4 MediaPipe Integration

**Initialization (once on page load):**
```javascript
import { FaceLandmarker, FilesetResolver } from
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const vision = await FilesetResolver.forVisionTasks("/onframe/web/models/");
const faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
  baseOptions: { modelAssetPath: "/onframe/web/models/face_landmarker.task" },
  runningMode: "IMAGE",
  outputFaceBlendshapes: true,               // +5ms; enables squinch + Duchenne smile (§1.13)
  outputFacialTransformationMatrixes: true,
  numFaces: 1,
});
```

**Model file** — downloaded at Docker build time via `curl`, served from same origin. WASM runtime served from jsdelivr CDN (cached by browser).

**Head pose from 4×4 transformation matrix (column-major Float32Array):**
```javascript
function extractHeadPose(matrix) {
  const d = matrix.data;
  // Rotation sub-matrix (upper-left 3×3, column-major)
  const r12 = d[9], r02 = d[8], r22 = d[10], r10 = d[1], r11 = d[5];
  return {
    pitch: Math.asin(-r12),           // chin up/down (radians)
    yaw:   Math.atan2(r02, r22),      // head turn L/R (radians)
    roll:  Math.atan2(r10, r11),      // head tilt (radians)
  };
}
```

**Key landmark indices:**

| Index | Point | Used for |
|-------|-------|---------|
| 468 | Right iris center | Eye analysis, catchlight |
| 473 | Left iris center | Eye analysis, catchlight |
| 469–472 | Right iris ring | Iris radius |
| 474–477 | Left iris ring | Iris radius |
| 159 | Right upper lid center | Squinch ratio |
| 145 | Right lower lid center | Squinch ratio |
| 386 | Left upper lid center | Squinch ratio |
| 374 | Left lower lid center | Squinch ratio |
| 1 | Nose tip | Nose shadow region |
| 10 | Forehead top | Headroom measurement |
| 17 | Chin bottom | Crop line safety |
| 152 | Chin bottom (alt) | Face height |
| 168 | Nose bridge | Lighting split point |
| 13 | Upper lip center | Lip gap |
| 14 | Lower lip center | Lip gap |

Face bounding box = min/max of all 478 landmark x/y values.

---

### 1.5 Canvas Analysis Pipeline

**EXIF stripping + canvas setup:**
```javascript
async function drawToCanvas(file) {
  const blobUrl = URL.createObjectURL(file);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);   // redraw strips EXIF
      img.src = '';               // release img element
      URL.revokeObjectURL(blobUrl);
      resolve({ canvas, ctx });
    };
    img.src = blobUrl;
  });
}
```

**Sharpness — Laplacian variance on face region (proxy for VNDetectFaceQualityRequest):**
```javascript
function computeSharpness(ctx, faceRect) {
  const { data, width, height } = ctx.getImageData(
    faceRect.x, faceRect.y, faceRect.width, faceRect.height);
  let variance = 0, count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const luma = (i) => 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2];
      const i = (y * width + x) * 4;
      const lap = -4*luma(i) + luma(i-4) + luma(i+4)
                + luma(i - width*4) + luma(i + width*4);
      variance += lap * lap;
      count++;
    }
  }
  return Math.min(1.0, (variance / count) / 500);  // normalize to 0–1
}
```

**Exposure EV:**
```javascript
function computeExposureEV(ctx, w, h) {
  const { data } = ctx.getImageData(0, 0, w, h);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4)
    sum += 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2];
  const meanLuma = (sum / (data.length / 4)) / 255;
  return Math.log2(Math.max(meanLuma, 0.001) / 0.18);
}
```

**Lighting ratio (key:fill from left/right face halves):**
```javascript
function computeLightingRatio(ctx, faceRect) {
  const hw = Math.floor(faceRect.width / 2);
  const avg = (d) => { let s=0; for(let i=0;i<d.length;i+=4) s+=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2]; return s/(d.length/4); };
  const L = avg(ctx.getImageData(faceRect.x,      faceRect.y, hw, faceRect.height).data);
  const R = avg(ctx.getImageData(faceRect.x + hw, faceRect.y, hw, faceRect.height).data);
  return {
    ratio:     Math.max(L, R) / Math.max(Math.min(L, R), 0.001),
    direction: L > R ? 'left' : 'right',
  };
}
```

**Catchlight detection + clock position (specular highlight in 40×40px eye crop):**
```javascript
function detectCatchlight(ctx, eyeCenter) {
  const S = 40, H = S / 2;
  const { data } = ctx.getImageData(eyeCenter.x - H, eyeCenter.y - H, S, S);
  let maxL = 0, bx = H, by = H;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const l = 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2];
      if (l > maxL) { maxL = l; bx = x; by = y; }
    }
  }
  if (maxL < 200) return { detected: false, clockHour: null };
  const dx = bx - H, dy = H - by;  // flip Y: up = positive
  const deg = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
  const clockHour = Math.round(((90 - deg + 360) % 360) / 30) || 12;
  return { detected: true, clockHour };  // clockHour 1–12
  // Clock → pattern: 11–1=butterfly, 10–11/1–2=loop(sweet), 4–8=Rembrandt, 3/9=split
}
```

**Color cast — R/G/B channel means on face region:**
```javascript
function detectColorCast(ctx, faceRect) {
  const { data } = ctx.getImageData(faceRect.x, faceRect.y, faceRect.width, faceRect.height);
  let R = 0, G = 0, B = 0, n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) { R += data[i]; G += data[i+1]; B += data[i+2]; }
  R /= n; G /= n; B /= n;
  return {
    warmth:      (R - B) / 255,            // positive = warm/flattering, negative = cool
    greenShift:  (G - (R + B) / 2) / 255,  // > 0.06 = problematic green cast
    isGreenCast: G > R + 15 && G > B + 15,
    isCoolCast:  B > R + 20,
    isWarm:      R > B + 15,
  };
}
```

**Skin smoothness — luma standard deviation in face region:**
```javascript
function skinSmoothness(ctx, faceRect) {
  const { data } = ctx.getImageData(faceRect.x, faceRect.y, faceRect.width, faceRect.height);
  const lumas = [];
  for (let i = 0; i < data.length; i += 4)
    lumas.push(0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2]);
  const mean = lumas.reduce((a, b) => a + b) / lumas.length;
  const variance = lumas.reduce((s, l) => s + (l - mean) ** 2, 0) / lumas.length;
  return 1 - Math.min(1, Math.sqrt(variance) / 60);  // 0 = harsh/hard light, 1 = diffused
}
```

**Privacy cleanup (called immediately after VisionMetrics is assembled):**
```javascript
function clearImageData(canvas, ctx) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvas.width = 1;   // forces memory release in some browsers
}
```

---

### 1.6 VisionMetrics (JS)

```javascript
{
  // Core detection
  faceDetected: boolean,
  faceBoundingBox: { x, y, width, height },  // pixel coordinates
  faceYawAngle: number,     // radians
  facePitchAngle: number,
  faceRollAngle: number,
  leftEyeCenter:  { x, y },
  rightEyeCenter: { x, y },
  imageWidthPx: number,
  imageHeightPx: number,

  // Lighting (original)
  faceQualityScore: number,      // 0–1, Laplacian variance (whole face)
  exposureEV: number,
  hasCatchlights: boolean,
  catchlightPositions: string[], // kept for compat
  lightingRatio: number,
  lightingDirection: 'left' | 'right' | 'unknown',
  backgroundBrightness: number,

  // Lighting (enhanced — §1.14)
  catchlightClockHour: number | null,  // 1–12; null = no catchlight
  lightingPattern: 'flat' | 'loop' | 'butterfly' | 'Rembrandt' | 'split' | 'directional',
  lightingBroadShort: 'broad' | 'short' | 'frontal' | 'unknown',
  colorCastWarmth: number,       // −1 (cool/blue) to +1 (warm/orange)
  colorCastGreenShift: number,   // > 0.06 = problematic
  isGreenCast: boolean,
  skinSmoothness: number,        // 0 (harsh/hard light) to 1 (diffused/smooth)

  // Composition (original)
  faceFramingRatio: number,      // face bbox area / image area
  eyelineYPosition: number,      // 0=top, 1=bottom; ideal 0.28–0.38
  horizontalOffset: number,      // −1 to +1; 0 = centered

  // Composition (enhanced — §1.14)
  headroomRatio: number,         // lm10.y / imageHeight; ideal 0.06–0.15
  cropLineSafety: 'safe' | 'chin-clipped' | 'chin-neck-crop' | 'shoulder-crop',
  leadRoomViolation: boolean,    // gaze toward edge without lead space
  viewTypeName: string,          // "Classic 3/4 view", "Full frontal", etc.

  // Sharpness (enhanced — §1.14)
  leftEyeSharpness: number,      // 0–1 Laplacian on 50×50px around lm473
  rightEyeSharpness: number,     // 0–1 Laplacian on 50×50px around lm468
  nearEyeSharpness: number,      // camera-side eye (determined by yaw direction)

  // Eyes & expression (enhanced — §1.14; blendshapes required for accuracy)
  squinchRatio: number,          // lower-lid gap / upper-lid gap; ideal < 0.85
  isSquinching: boolean,         // confident compression (ratio < 0.80)
  isWideEyed: boolean,           // scleral show above 1.10
  inferiorScleralShow: number,   // white below iris / aperture; > 0.15 = coaching needed
  isSmiling: boolean,
  isDuchenneSmile: boolean,      // genuine (eye crinkle) vs forced (mouth only)
  lipGapRatio: number,           // lip gap / face height; 0.005–0.030 = natural

  // Cloud mode
  humanReadableSummary: string,  // ~400 chars of text including enhanced metrics
}
```

---

### 1.7 FeedbackSynthesizer.js (rules-based, local mode)

Port of `ios/PortraitFix.swiftpm/Sources/App/Services/FeedbackSynthesizer.swift`, enhanced with research signals from §1.14. Eye Contact is now fully computed (was fixed at 70).

| Category | Weight | Base | Key penalties / bonuses |
|----------|--------|------|------------------------|
| Lighting | 0.30 | 75 | −20 no catchlight; −15 flat ratio (<1.3); −20 harsh (>5:1); −15 EV out of range; **−10 broad lighting; −10 green cast; −5 cool cast; −8/−15 skin roughness; +5 catchlight at 10–2 o'clock** |
| Head Angle & Pose | 0.25 | 80 | −15 frontal (<5°); −25 over-turned (>45°); −20 chin raised (pitch <−15°); −15 chin down (pitch >12°); −10 roll >12°; **view type named in tip text** |
| Composition & Framing | 0.20 | 80 | −20 eyeline >0.55; −15 eyeline <0.20; −20 face <15% frame; −15 face >75% frame; −10 \|offset\| >0.5; **−15 crown clipped; −10 excessive headroom (>22%); −12 chin/neck crop; −8 shoulder crop; −5 lead room violation; portrait type named in tip** |
| Sharpness & Focus | 0.15 | — | score = faceQualityScore × 100; **−15 if near eye sharpness < 0.5 in 3/4 view** |
| Background | 0.05 | 65 | −15 brightness >0.8; +10 brightness <0.1 |
| Eye Contact & Gaze | 0.05 | 70→computed | **−10 wide-eyed/scleral show; −8 inferior scleral >0.15; +15 squinching; +10 Duchenne smile** |

Coaching tip templates (photographer-sourced — Peter Hurley / Sue Bryce / Lindsay Adler):
- Catchlight: *"Catchlight at {N} o'clock — {pattern} lighting. Sweet spot is 10–2 o'clock."*
- Broad light: *"Broad lighting detected — light the shadow side for a sculpted look."*
- Green cast: *"Green color cast — move to daylight or use daylight-balanced LEDs."*
- Wide-eyed: *"Slightly raise your lower lids — think confident, not startled."*
- Squinching: *"Eyes show confident engagement — the lower lid compression is working."*
- View type: *"Classic 3/4 view — the most flattering angle for most faces."*
- Neck crop: *"Frame bottom cuts at the neck — crop tighter (above chin) or looser (at chest)."*

Returns `{ cards: FeedbackCard[], overallScore: number }`.
`overallScore = Σ(card.score × category.weight)`.

---

### 1.8 Vertex AI Gemini — Multipart Route

**Client (`cloud.js`):**
```javascript
async function fetchCloudCoaching(file, { summary, photoType, localScores, localCards }) {
  const photo = await downscaleImage(file, { maxEdge: 1280, quality: 0.85 });
  const form = new FormData();
  form.append('photo', photo, 'photo.jpg');
  form.append('metrics', JSON.stringify({ summary, photoType, localScores, localCards }));
  const res = await fetch('/onframe/web/api/analyze', {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  // Never throws — returns { aiUnavailable: true } on any failure
  return res.ok ? res.json() : { aiUnavailable: true };
}
```

**Server (`web-server/server.js`) — Express + multer.memoryStorage() on port 3004:**
```
POST /onframe/web/api/analyze
  multipart/form-data:
    photo   — image/jpeg|webp, ≤ 6 MB
    metrics — JSON string, ≤ 16 KB
  Total request ≤ 8 MB
  Rate limit: 10 req/min per IP (express-rate-limit)
  Log: timestamp + status code only — never the photo bytes or metrics body
  Call Vertex AI Gemini 2.5 Flash via predict endpoint with photo (inline base64) + structured prompt embedding metrics
  Return 200 { aiSummary }                         on success
  Return 200 { aiUnavailable: true }               on Vertex failure / timeout / malformed / missing config
  Return 400 { error: "<message>" }                on validation errors
  Buffer is nulled after handling — no disk writes
```

**Env vars (Cloud Run):**
```
VERTEX_PROJECT=ai-dev-463705
VERTEX_LOCATION=us-central1
VERTEX_MODEL=gemini-2.5-flash   # default; any Gemini model id is fine
PORT=3004
```
Cloud Run service account needs `roles/aiplatform.user`. No API keys.

---

### 1.9 UI Design

Single cloud-only flow — no mode toggle. The local synthesizer is a degraded fallback shown with a subtle banner when the Vertex call fails.

**States:**

| State | Display |
|-------|---------|
| `idle` | Upload zone (file picker + camera on mobile); privacy disclosure |
| `analyzing` | Photo dimmed + centered spinner + "Analyzing your photo…" → "Asking AI for coaching…" |
| `complete` | Photo overlay + score + carousel of 6 coaching cards sorted worst-first; AI summary in sheet header; "AI coaching unavailable" banner if `aiUnavailable` |
| `error` | Friendly message (no face / oversized file / device unsupported) |

**Responsive layout:**
- Mobile-only (430px max-width). Desktop visitors hit a block message before the app boots.

---

### 1.10 File Structure

```
onframe/web/
├── index.html          SPA shell; imports ES modules
├── style.css           Dark theme (#0d1117), pink accent (#f472b6), responsive
├── app.js              State machine; wires file picker, camera, results overlay
├── analysis.js         loadMediaPipe(), analyzeImage(file) → VisionMetrics (face + pose)
├── synthesizer.js      Rules-based coaching → { cards, overallScore } (authoritative for cards)
├── composition.js      Pure geometry helpers (headroom, photo type)
├── downscale.js        downscaleImage(file, opts) → JPEG Blob (re-encodes, strips EXIF)
├── cloud.js            fetchCloudCoaching(file, metrics) → { aiSummary?, aiUnavailable? }
├── device.js           Mobile-only gate (matchMedia + maxTouchPoints)
├── mediapipe/          Self-hosted vision_bundle.mjs + WASM
└── models/             Built at Docker build time
    ├── face_landmarker.task         (~2.4MB)
    └── pose_landmarker_lite.task    (~5.5MB)

onframe/web-server/
├── package.json        { express, express-rate-limit, multer, google-auth-library }
├── vertex.js           Vertex AI Gemini 2.5 Flash client (createVertexClient)
└── server.js           Multipart /analyze + /report + /health, port 3004
```

---

### 1.11 Infrastructure Changes

**`Dockerfile` additions:**
```dockerfile
# web-server
COPY onframe/web-server/package*.json ./onframe/web-server/
RUN cd onframe/web-server && npm ci --omit=dev
COPY onframe/web-server/server.js ./onframe/web-server/server.js

# Static web files
COPY onframe/web/ /usr/share/nginx/html/onframe/web/

# Download MediaPipe model at build time (self-hosted)
RUN mkdir -p /usr/share/nginx/html/onframe/web/models && \
    curl -fsSL -o /usr/share/nginx/html/onframe/web/models/face_landmarker.task \
    https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
```

**`deploy/supervisord.conf` addition:**
```ini
[program:onframe-web]
command=node /app/onframe/web-server/server.js
environment=PORT="3004",NODE_ENV="production",VERTEX_PROJECT="%(ENV_VERTEX_PROJECT)s",VERTEX_LOCATION="%(ENV_VERTEX_LOCATION)s",VERTEX_MODEL="%(ENV_VERTEX_MODEL)s"
autostart=true
autorestart=true
stderr_logfile=/dev/stderr
stdout_logfile=/dev/stdout
```

**`deploy/nginx.conf` additions (inside `server {}`):**
```nginx
location = /onframe/web    { return 301 /onframe/web/; }

location = /onframe/web/api/analyze {
    proxy_pass         http://127.0.0.1:3004;
    proxy_http_version 1.1;
    proxy_set_header   Host            $host;
    proxy_set_header   X-Real-IP       $remote_addr;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 30s;
    client_max_body_size 8m;   # multipart photo (≤6 MB) + metrics (≤16 KB) + headers
}

location /onframe/web/models/ {
    try_files $uri =404;
}

location /onframe/web/ {
    add_header Content-Security-Policy "default-src 'self'; \
      script-src 'self' cdn.jsdelivr.net 'wasm-unsafe-eval'; \
      script-src-elem 'self' cdn.jsdelivr.net; \
      connect-src 'self' cdn.jsdelivr.net; \
      style-src 'self' 'unsafe-inline'; \
      img-src 'self' data: blob:; \
      worker-src blob:; \
      object-src 'none'; frame-ancestors 'none';" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    try_files $uri /onframe/web/index.html;
}
```

---

### 1.12 Verification

1. `docker build` succeeds; `face_landmarker.task` and `pose_landmarker_lite.task` present in image
2. `/onframe/web/` loads on Safari iOS — upload zone visible, no console errors
3. Desktop browsers see the block message (mobile-only gate)
4. Pick a portrait → 6 coaching cards render with scores; AI summary appears in sheet header when Vertex is reachable
5. Network tab: `POST /api/analyze` carries multipart with `photo` + `metrics`; response is `{ aiSummary }` or `{ aiUnavailable: true }`
6. Storage tab: no image data in localStorage/sessionStorage/IndexedDB/CacheStorage after analysis
7. Missing `VERTEX_PROJECT` → server still returns 200 `{ aiUnavailable: true }`; UI shows local cards + subtle "AI coaching unavailable" banner
8. POST body > 8 MB → nginx returns 413 before reaching Node
9. POST with `photo` field > 6 MB or `metrics` field > 16 KB → server returns 400 with `{ error }`

---

### 1.13 Competitive Landscape & Differentiation

---

#### Competitor Matrix

| Tool | Analysis Type | Privacy | Price | Platform | Gap vs Portrait Coach |
|------|--------------|---------|-------|----------|----------------------|
| **Photofeeler** | Human crowd scores: Competence, Likability, Influence | Cloud; photo shown to strangers during test | Free (karma) / $20 per 100 credits | Web | No technique coaching; tells you *that* a photo underperforms, not *why* |
| **Snappr Photo Analyzer** | AI scoring: composition, lighting, LinkedIn prediction | Cloud; retention unclear | Free | Web | Black-box scoring, no explanation of what the flaw is |
| **HeadshotsByAI Analyzer** | 6-category AI scoring (lighting, bg, composition, expression, clarity, professional look) | Cloud ("not stored" claim) | Free | Web | Cloud-based despite claims; generic tips ("use natural light"); no landmark analysis |
| **UFreeTools Profile Analyzer** | Local browser: head position, smile, eye contact, lighting (face-api.js) | Fully local ✓ | Free | Web | 68 landmarks, no 3D — vs. Portrait Coach's 478 3D; no lighting pattern, no squinch |
| **Bumble AI Photo Feedback** | Lighting quality, face visibility, variety; NLP for bio | Cloud (in-platform) | Free (Bumble users) | Mobile | Locked to Bumble; shallow coaching ("face obscured by sunglasses") |
| **Aragon AI / Secta / HeadshotPro** | AI headshot generator — no coaching | Cloud | $29–$75 one-time | Web | Generates new image; teaches nothing; does not serve skill improvement |
| **Jenova AI Photography Coach** | General LLM photo critique (any genre) | Cloud (image sent to LLM) | Free (limited) / $20–$200/mo | Web, iOS, Android | General-purpose; no structured scoring; no landmark analysis |
| **Remini / Picsart** | Photo enhancer/restorer | Cloud | Freemium / ~$10/mo | iOS, Android, Web | Not coaching — transforms image, not photographer skills |
| **Adobe Lightroom / Capture One** | Editing suites; AI for culling/masking/denoising | Cloud (LR) / Local (CO) | $10–$55/mo | Desktop + Web | Coach editing, not capture; no pose/lighting/composition analysis |
| **Google Pixel Camera Coach** | Real-time framing + lighting guidance during capture | On-device | Free (Pixel 10+ only) | Android | Hardware-locked; capture-time only, not retrospective; shallow technique depth |
| **Virtual Lighting Studio (zvork.fr)** | Interactive lighting simulator (no photo upload) | N/A (no photo) | Free | Web | Educational simulation, not photo analysis |
| **ROAST.dating** | Dating profile optimizer (AI + human expert) | Cloud; vague retention | Paid | Web | Dating-only context; no photography technique |

---

#### Confirmed Gaps — What No Competitor Does

1. **Lighting pattern classification from a real photo.** No tool found — anywhere — that identifies Rembrandt, Loop, Butterfly, or Split lighting from an uploaded portrait. This is entirely novel.

2. **Squinch detection, Duchenne smile, iris/scleral show.** Searched specifically; zero products offer this. These are discussed only in photography education content, never as automated signals.

3. **On-device privacy + portrait technique depth combined.** UFreeTools is local but shallow (face-api.js, 68 landmarks). Every deep analyzer is cloud-based. No tool occupies both dimensions.

4. **Zero pixels to server — structurally, not by policy.** Competitors claiming privacy say "we don't store your photo" — but it still traverses the network. Portrait Coach's architecture makes pixel transmission structurally impossible, not just policy-promised.

5. **Photography craft vocabulary in output.** Competitors output scores and generic advice. Portrait Coach outputs "Rembrandt triangle detected, catchlight at 10 o'clock, 3:1 ratio" — the vocabulary photographers actually use.

---

#### Positioning Statement

> **"Portrait Coach is the only tool that analyzes your portrait photos with professional-level technique feedback — lighting patterns, catchlights, head pose, and expression science — entirely in your browser, with your photos never leaving your device."**

Privacy angle (EU/GDPR-sensitive markets): *"Your photo stays on your device. Always. Zero pixels sent to any server."*

---

#### Top 5 Differentiation Opportunities

**1. Make Privacy Verifiable, Not Just Stated**
Every competitor either uploads to cloud or makes vague "not stored" promises. Portrait Coach's MediaPipe-in-browser architecture makes pixel transmission structurally impossible. The EU AI Act classifies face data as sensitive biometric data — cloud-based analyzers carry compliance risk that grows annually. Action: add a transparency page showing (or live-demoing) the network tab during analysis. Convert a claim into proof.

**2. Own the Photography Craft Vocabulary**
No competitor speaks the language of portrait photographers. "Likability 71%" teaches nothing. "Loop lighting detected, catchlight at 1 o'clock — move the key light 10° left to close the nose shadow loop" teaches the craft. This vocabulary is recognized and trusted by the audience Portrait Coach wants (serious amateurs, semi-pros, photography students). Action: double down on this language throughout UX copy; add a glossary panel explaining each term alongside scores.

**3. The Learning Loop — Between-Session Coach**
The entire AI headshot generator market gives you a better synthetic image but teaches you nothing. Portrait Coach fills the gap: upload last session's portrait, learn exactly what went wrong technically, fix it before the next shoot. Frame as "the tool that improves *you*, not just the photo." This positions alongside (not against) CreativeLive/Udemy courses.

**4. LinkedIn Headshot Mode**
The professional headshot market is ~$500M growing 9% CAGR, driven by LinkedIn and remote work. The vast majority of LinkedIn's 1B+ users lack professional headshots. AI generators help but teach nothing. A dedicated "LinkedIn Headshot" mode — professional look scoring, appropriate crop coaching, clean background analysis, confident expression detection — fills a gap no generator addresses and targets an enormous user segment.

**5. Actor/Casting Headshot Mode**
Actors retake headshots frequently and pay $200–$500+ for photographer sessions. Casting directors care about the same signals Portrait Coach analyzes: industry-standard lighting patterns, authentic expression (Duchenne detection directly relevant), appropriate crop. Actors are motivated to improve technique. High willingness to pay for a premium tier. Secta Labs even mentions Rembrandt/butterfly lighting in their actor-headshot marketing — demonstrating the audience awareness — but offers no analysis, only generation.

---

#### Three Features to Widen the Moat

**1. On-Device Learning History**
Store past analyses in localStorage (never server-side). Show score trends over time per category ("Lighting: 58 → 74 over 6 sessions"). Include side-by-side comparison of two uploads. No competitor offers a portrait technique learning loop. Privacy story gets stronger: complete coaching history never leaves the device.

**2. Personalized Pre-Shoot Brief**
After analysis, generate a one-page "next session checklist" — specific, actionable: "Move key light 15° left to close the nose shadow. Prompt subject to squinch slightly. Ensure catchlight lands between 10–2 o'clock." Shareable/printable. Serves the learning loop use case directly. Natural viral mechanism — photographers share coaching cards in r/portraits, DPReview, strobist communities.

**3. Lighting Diagram Generator**
Based on the detected lighting pattern, generate an SVG lighting diagram showing where the key/fill/background lights were positioned to create the detected setup. If "near-loop with catchlight slightly low," annotate what to adjust. Portrait Coach would be the first tool to automatically reverse-engineer a lighting setup from a photo and explain it visually. Virtual Lighting Studio (zvork.fr) does interactive diagrams but requires manual setup — no photo analysis. High earned media potential in photography education communities.

---

### 1.14 Photography Research — Enhanced Signals

Deep research across Peter Hurley, Sue Bryce, Lindsay Adler, Chase Jarvis, Annie Leibovitz, Joe McNally, and NatGeo portrait standards. Maps world-class portrait techniques to browser-measurable signals.

---

#### Portrait Photography Top 5 Mistakes (Photographer Consensus)

| Rank | Mistake | Current Coverage | Gap |
|------|---------|-----------------|-----|
| 1 | No catchlights — "dead eyes" | `hasCatchlights` ✓ | Clock position not measured |
| 2 | Flat lighting — no dimension | `lightingRatio` ✓ | Pattern not classified |
| 3 | Full-frontal / passport pose | `faceYawAngle` ✓ | View type not named in tips |
| 4 | Eyes not sharp / focus miss | Laplacian on face bbox | Per-eye sharpness not computed |
| 5 | Subject too small in frame | `faceFramingRatio` ✓ | Portrait type not named in tips |

---

#### Priority 1 — High Impact, Zero New Dependencies

**1. Catchlight Clock Position**

Current implementation returns `detected: boolean`. Enhance to return the clock hour:

```javascript
function catchlightClockPosition(ctx, irisCenter) {
  const S = 40, H = S / 2;
  const { data } = ctx.getImageData(irisCenter.x - H, irisCenter.y - H, S, S);
  let maxL = 0, bx = H, by = H;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const l = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
      if (l > maxL) { maxL = l; bx = x; by = y; }
    }
  }
  if (maxL < 200) return null;  // no catchlight
  const dx = bx - H, dy = H - by;  // flip Y so up = positive
  const deg = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
  const hour = Math.round(((90 - deg + 360) % 360) / 30) || 12;
  return hour;  // 1–12
}
```

Clock position → lighting pattern:

| Clock | Likely Pattern |
|-------|----------------|
| 11–1 | Butterfly/Paramount |
| 1–2 or 10–11 | Loop (sweet spot) |
| 4–5 or 7–8 | Rembrandt |
| 3 or 9 | Split |
| null | No catchlight — "dead eyes" |

Coaching: *"Catchlight at {N} o'clock — {pattern} lighting. Sweet spot is 10–2 o'clock."*

---

**2. Color Cast Detection**

One-pass Canvas scan. Green fluorescent cast is the most unflattering and completely absent from current pipeline.

```javascript
function colorCast(ctx, faceRect) {
  const { data } = ctx.getImageData(faceRect.x, faceRect.y, faceRect.width, faceRect.height);
  let R = 0, G = 0, B = 0, n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) { R += data[i]; G += data[i+1]; B += data[i+2]; }
  R /= n; G /= n; B /= n;
  return {
    warmth: (R - B) / 255,           // positive = warm/golden, negative = cool/blue
    greenShift: (G - (R + B) / 2) / 255,  // positive = green cast
    isGreenCast: G > R + 15 && G > B + 15,
    isCoolCast: B > R + 20,
    isWarm: R > B + 15,
  };
}
```

Score impacts: green cast −10; blue/cool cast −5; warm cast 0 (slightly flattering).

Coaching: *"Green color cast detected — fluorescent or mixed sources. Move to daylight or use daylight-balanced LEDs."*

---

**3. Broad vs Short Lighting Classification**

Zero additional computation — combines already-extracted `yawRadians` and `lightingDirection`:

```javascript
function broadVsShort(yawRadians, lightingDirection) {
  const faceRight = yawRadians >  0.087;  // > 5°
  const faceLeft  = yawRadians < -0.087;
  if (!faceRight && !faceLeft) return 'frontal';
  if (faceRight && lightingDirection === 'right') return 'broad';
  if (faceRight && lightingDirection === 'left')  return 'short';
  if (faceLeft  && lightingDirection === 'left')  return 'broad';
  if (faceLeft  && lightingDirection === 'right') return 'short';
  return 'unknown';
}
```

Score: broad lighting −10.

Coaching: *"Broad lighting detected (lit side is facing the camera) — turn the face so the lit side is turned away. Short lighting slims, sculpts, and flatters almost universally."* (Peter Hurley: "Short light 95% of the time.")

---

**4. Lighting Pattern Classification**

Combine ratio + clock position to classify pattern. Purely informational — enriches coaching language.

```javascript
function classifyLightingPattern(ratio, clockPos) {
  if (!clockPos)              return 'flat';
  if (ratio > 4.0 && (clockPos === 3 || clockPos === 9))           return 'split';
  if (ratio > 3.0 && clockPos >= 4 && clockPos <= 8)               return 'Rembrandt';
  if (ratio < 1.5 && (clockPos >= 11 || clockPos <= 1))            return 'butterfly';
  if (ratio >= 1.5 && ratio <= 3.5 && (clockPos >= 10 || clockPos <= 2)) return 'loop';
  return 'directional';
}
```

Coaching templates:
- **Rembrandt**: *"Classic Rembrandt lighting. Look for the small triangle of light on the shadow cheek — if it's missing, move the light slightly toward the subject."*
- **Loop**: *"Loop lighting — the most versatile pattern. The diagonal nose shadow stops before the lip. Well done."*
- **Butterfly**: *"Butterfly/Paramount lighting. Flattering for high cheekbones and symmetrical faces."*
- **Split**: *"Split lighting. Very dramatic — appropriate for editorial and character work. For commercial headshots, soften to loop."*
- **Flat**: *"Flat lighting detected — the face lacks dimension and bone structure. Move the light 30–45° to the side, or move the subject 45° toward a window."*

---

**5. Headroom Measurement**

Landmark 10 is the forehead/hairline top in MediaPipe's 478-point map.

```javascript
function headroomRatio(landmarks, imageHeight) {
  return (landmarks[10].y * imageHeight) / imageHeight;  // normalized 0–1
}
```

| Headroom (lm10.y / height) | Assessment |
|---------------------------|------------|
| < 0.04 | Crown clipped |
| 0.04–0.06 | Very tight, intentional crop |
| 0.06–0.15 | Ideal |
| 0.15–0.22 | Slightly too much headroom |
| > 0.22 | Excessive — floating head |

Score: crown clipped −15; excessive headroom −10.

Coaching: *"Leave 6–12% of the frame above the crown. Too much empty space above the head makes the subject look small and adrift in the frame."*

---

**6. Per-Eye Sharpness**

The #1 focus rule: eyes must be sharp, specifically the near eye in a 3/4 view.

```javascript
function eyeRegionSharpness(ctx, irisCenter, imageWidth, imageHeight, radius = 25) {
  const px = irisCenter.x * imageWidth, py = irisCenter.y * imageHeight;
  const { data, width } = ctx.getImageData(px - radius, py - radius, radius * 2, radius * 2);
  let variance = 0, count = 0;
  for (let y = 1; y < radius * 2 - 1; y++) {
    for (let x = 1; x < radius * 2 - 1; x++) {
      const i = (y * radius * 2 + x) * 4;
      const luma = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
      const lap = -4 * luma
        + (0.299 * data[i-4] + 0.587 * data[i-3] + 0.114 * data[i-2])
        + (0.299 * data[i+4] + 0.587 * data[i+5] + 0.114 * data[i+6])
        + (0.299 * data[i - radius*8] + 0.587 * data[i - radius*8+1] + 0.114 * data[i - radius*8+2])
        + (0.299 * data[i + radius*8] + 0.587 * data[i + radius*8+1] + 0.114 * data[i + radius*8+2]);
      variance += lap * lap;
      count++;
    }
  }
  return Math.min(1.0, (variance / count) / 500);
}
// Use: if yaw > 15°, near eye (camera-side) should score ≥ far eye
// Penalty: near eye sharpness < 0.5 → −15 from Sharpness score
```

Coaching: *"The camera-side eye is soft — ensure eye-detect AF is locked on the near eye, not the far eye or nose. At f/2.8 and closer, depth of field is just millimeters."*

---

**7. Crop Line Safety Check**

Uncomfortable crops occur at anatomical joints. Compare frame height to face height:

```javascript
function cropLineSafety(faceRect, imageHeight) {
  const faceBottom = faceRect.y + faceRect.height;  // chin position in pixels
  const frameBottomFromFace = imageHeight - faceBottom;  // space below chin
  // Danger zones relative to face height:
  const fH = faceRect.height;
  if (frameBottomFromFace < fH * 0.05) return 'chin-clipped';   // chin cut off
  if (frameBottomFromFace < fH * 0.25) return 'chin-neck-crop'; // cuts at neck (bad)
  if (frameBottomFromFace < fH * 0.55) return 'shoulder-crop';  // cuts at shoulder (bad)
  return 'safe';
}
```

Score: `chin-clipped` −15; `chin-neck-crop` −12; `shoulder-crop` −8.

Coaching: *"Frame bottom cuts at the neck — one of the most uncomfortable crops in portraiture. Crop tighter (above the chin) or looser (at the chest or waist)."*

---

**8. View Type Named in Coaching Tips**

Zero additional computation — classify the already-extracted `faceYawAngle` and surface the name:

| Yaw | View Name | Coaching Note |
|-----|-----------|---------------|
| 0–5° | Full frontal | *"Passport pose — a 15° turn adds depth and dimension"* |
| 5–15° | 7/8 view | *"Subtle turn — consider turning a little more to show cheekbone structure"* |
| 15–30° | Classic 3/4 | *"Classic 3/4 view — the most flattering angle for most faces"* |
| 30–45° | 2/3 view | *"Strong 2/3 view — dramatic and editorial"* |
| > 45° | Strong turn | *"Turned too far — far eye becomes partially hidden"* |

---

#### Priority 2 — Requires `outputFaceBlendshapes: true` in MediaPipe

Enable by adding `outputFaceBlendshapes: true` to `FaceLandmarker.createFromOptions`. Adds ~5ms to inference. Unlocks:

**1. Squinch Detection (Peter Hurley's Signature Technique)**

The squinch is compression of the lower eyelid upward — the #1 expression technique for confident headshots. It differs from squinting (both lids close) and wide-eyed (both lids open).

Via blendshapes: `eyeSquintLeft`, `eyeSquintRight` — score 0.1–0.4 = ideal squinch; > 0.6 = excessive squint.

Via landmarks (fallback when blendshapes off):
```javascript
function squinchRatio(landmarks) {
  // Right eye
  const rUpperGap = landmarks[468].y - landmarks[159].y;  // iris to upper lid
  const rLowerGap = landmarks[145].y - landmarks[468].y;  // lower lid to iris
  const rRatio = rLowerGap / Math.max(rUpperGap, 0.001);
  // Left eye
  const lUpperGap = landmarks[473].y - landmarks[386].y;
  const lLowerGap = landmarks[374].y - landmarks[473].y;
  const lRatio = lLowerGap / Math.max(lUpperGap, 0.001);
  const avg = (rRatio + lRatio) / 2;
  return {
    ratio: avg,
    isSquinching: avg < 0.80,       // lower lid compressing up
    isWideEyed: avg > 1.10,         // scleral show below iris — "prey animal" look
  };
}
```

Score: squinching → +15 Eye Contact bonus; wide-eyed → −10.

Coaching:
- Squinching: *"Eyes show confident engagement — the lower lids are compressing naturally."*
- Wide-eyed: *"Eyes are wide open — slightly raise your lower lids. Think 'confident' not 'startled'. The lower lid doing the work is Peter Hurley's key insight for compelling headshots."*

---

**2. Duchenne Smile Detection**

A genuine smile (Duchenne) activates orbicularis oculi (eye crinkle) in addition to the mouth. A social/forced smile is mouth-only.

Via blendshapes:
```javascript
function duchenneSmile(blendshapes) {
  const get = name => blendshapes.find(b => b.categoryName === name)?.score ?? 0;
  const mouthSmile   = (get('mouthSmileLeft') + get('mouthSmileRight')) / 2;
  const eyeCrinkle   = (get('cheekSquintLeft') + get('cheekSquintRight')) / 2;
  const isSmiling    = mouthSmile > 0.25;
  const isDuchenne   = isSmiling && eyeCrinkle > 0.20;
  return { isSmiling, isDuchenne, mouthSmile, eyeCrinkle };
}
```

Score: genuine Duchenne smile → +10 Eye Contact; forced smile detected → coaching tip only (no penalty).

Coaching:
- Duchenne: *"Genuine smile — the eyes are engaged. Excellent."*
- Forced: *"Smile looks a little posed — think of something genuinely funny or ask the photographer to tell you a real joke. The difference shows immediately."*

---

**3. Lip Separation**

Slightly parted lips (0.5–2% of face height gap) read as natural and relaxed. Pressed lips read as tension; wide-open reads as mid-speech.

Via blendshapes: `mouthOpen` score, or via landmarks:
```javascript
function lipGap(landmarks, faceHeight) {
  const gap = (landmarks[14].y - landmarks[13].y) / faceHeight;
  return { gap, isClosed: gap < 0.005, isNatural: gap >= 0.005 && gap <= 0.030 };
}
```

Score: closed lips during smiling → +3 tip; natural gap → informational.

Coaching: *"Slightly parted lips add a natural, relaxed quality to the portrait. Ask the subject to breathe through their mouth — it naturally relaxes the jaw."*

---

#### Priority 3 — Canvas-Only, No New Dependencies

**1. Skin Smoothness / Lighting Quality**

Standard deviation of luma within face region. Hard directional light increases local contrast; diffused light keeps variance low.

```javascript
function skinSmoothness(ctx, faceRect) {
  const { data } = ctx.getImageData(faceRect.x, faceRect.y, faceRect.width, faceRect.height);
  const lumas = [];
  for (let i = 0; i < data.length; i += 4)
    lumas.push(0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2]);
  const mean = lumas.reduce((a, b) => a + b) / lumas.length;
  const variance = lumas.reduce((s, l) => s + (l - mean) ** 2, 0) / lumas.length;
  return 1 - Math.min(1, Math.sqrt(variance) / 60);  // 0 = rough/harsh, 1 = smooth/diffused
}
```

Score: smoothness < 0.35 → −8 Lighting; < 0.20 → −15.

Coaching: *"Hard light is creating harsh texture on the skin. For flattering portraits, the light source should be larger than the subject's face — a softbox, overcast sky, or large north-facing window."*

---

**2. Iris-to-Sclera Ratio**

How much of the iris is visible within the eye aperture. Scleral show (white visible above or below iris) reads as surprise or discomfort.

```javascript
function irisToScleraRatio(landmarks, imageWidth, imageHeight) {
  // Right eye: iris center 468, upper lid center 159, lower lid center 145
  const scale = h => h * imageHeight;
  const rIrisY  = scale(landmarks[468].y);
  const rUpperY = scale(landmarks[159].y);
  const rLowerY = scale(landmarks[145].y);
  const aperture = rLowerY - rUpperY;
  // Iris radius from ring landmarks 469–472 (approximate as half the iris vertical span)
  const rIrisRadius = Math.abs(scale(landmarks[469].y) - scale(landmarks[471].y)) / 2;
  const coverage = (rIrisRadius * 2) / Math.max(aperture, 1);
  const superiorScleral = (rIrisY - rUpperY - rIrisRadius) / aperture;  // > 0.1 = visible white above
  const inferiorScleral = (rLowerY - rIrisY - rIrisRadius) / aperture;  // > 0.1 = visible white below
  return { coverage, superiorScleral, inferiorScleral };
}
```

Score: inferior scleral show > 0.15 → −8 Eye Contact.

Coaching: *"Visible white below the iris reads as a startled expression. Raise the lower lids slightly — the Hurley squinch eliminates inferior scleral show instantly."*

---

#### Enhanced VisionMetrics Fields

Add these fields to the `VisionMetrics` object:

```javascript
{
  // Lighting enhancements
  catchlightClockHour: number | null,    // 1–12, null if no catchlight
  lightingPattern: 'flat'|'loop'|'butterfly'|'Rembrandt'|'split'|'directional',
  lightingBroadShort: 'broad'|'short'|'frontal'|'unknown',
  colorCastWarmth: number,               // −1 to +1 (negative = cool, positive = warm)
  colorCastGreenShift: number,           // > 0.06 = problematic green cast
  skinSmoothness: number,                // 0–1

  // Head pose enhancements
  viewTypeName: string,                  // "Classic 3/4 view", "Full frontal", etc.

  // Sharpness enhancements
  leftEyeSharpness: number,             // 0–1 Laplacian on 50×50px around lm473
  rightEyeSharpness: number,            // 0–1 Laplacian on 50×50px around lm468
  nearEyeSharpness: number,             // max(left, right) based on yaw direction

  // Composition enhancements
  headroomRatio: number,                // lm10.y / imageHeight, ideal 0.06–0.15
  cropLineSafety: 'safe'|'chin-clipped'|'chin-neck-crop'|'shoulder-crop',
  leadRoomViolation: boolean,           // gaze direction vs horizontal position

  // Eye & expression (require blendshapes=true for accuracy)
  squinchRatio: number,                 // lower-lid gap / upper-lid gap; ideal < 0.85
  isSquinching: boolean,
  isWideEyed: boolean,
  irisToScleraRatio: number,            // 0.65–0.85 ideal
  inferiorScleralShow: number,          // fraction of aperture; > 0.15 = coaching needed
  isSmiling: boolean,
  isDuchenneSmile: boolean,             // genuine (eyes crinkle) vs forced (mouth only)
  lipGapRatio: number,                  // lip separation / face height
}
```

---

#### Enhanced Scoring Table

| New Signal | Category | Score Change | Threshold |
|-----------|----------|-------------|-----------|
| No catchlight | Lighting | −20 | Already implemented |
| Catchlight at 3/9 o'clock (split) | Lighting | −5 | New |
| Catchlight at 10–2 o'clock | Lighting | +5 bonus | New |
| Green color cast | Lighting | −10 | New |
| Cool/blue color cast | Lighting | −5 | New |
| Broad lighting detected | Lighting | −10 | New |
| Skin smoothness < 0.35 | Lighting | −8 | New |
| Skin smoothness < 0.20 | Lighting | −15 | New |
| Near eye sharpness < 0.5 | Sharpness | −15 | New |
| Crown clipped | Composition | −15 | New |
| Excessive headroom > 22% | Composition | −10 | New |
| Chin/neck crop | Composition | −12 | New |
| Shoulder crop | Composition | −8 | New |
| Lead room violation | Composition | −5 | New |
| Wide-eyed (scleral show) | Eye Contact | −10 | New |
| Inferior scleral show > 0.15 | Eye Contact | −8 | New |
| Squinching (lower lid compressed) | Eye Contact | +15 | New |
| Duchenne smile | Eye Contact | +10 | New |

---

#### MediaPipe Landmark Quick Reference

```
EYES
  Right iris center:    468    Left iris center:     473
  Right iris ring:      469, 470, 471, 472
  Left iris ring:       474, 475, 476, 477
  Right eye upper lid:  159 (center top), 246, 161, 160, 158, 157
  Right eye lower lid:  145 (center bottom), 33, 7, 163, 144, 153
  Left eye upper lid:   386 (center top), 466, 388, 387, 385, 384
  Left eye lower lid:   374 (center bottom), 263, 249, 390, 373, 380
  Right eye corners:    33 (inner), 133 (outer)
  Left eye corners:     362 (inner), 263 (outer)

EYEBROWS
  Right: 46, 53, 52, 65, 70, 63, 105, 66, 107
  Left:  276, 283, 282, 295, 300, 293, 334, 296, 336

NOSE
  Tip: 1, 4    Bridge: 168, 6, 197, 195, 5
  Right alar base: 48, 64    Left alar base: 275, 294

FACE STRUCTURE
  Forehead top: 10          Chin bottom: 152, 17
  Right cheekbone: 234, 93  Left cheekbone: 454, 323
  Right jaw: 172, 136, 58   Left jaw: 397, 365, 379

LIPS
  Upper center: 13    Lower center: 14
  Right corner: 61    Left corner: 291

FACE OVAL (36-point perimeter):
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
  397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
  172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109

MEDIAPIPE BLENDSHAPES (requires outputFaceBlendshapes: true)
  eyeSquintLeft, eyeSquintRight         → squinch detection
  cheekSquintLeft, cheekSquintRight     → Duchenne smile (eye crinkle)
  mouthSmileLeft, mouthSmileRight       → smile detection
  mouthOpen                             → lip separation
```

---

## Appendix A — Research Findings & Metric Improvements (2026-04-07)

> **Historical**: this appendix is the research pass that motivated the move from a text-only cloud path to a multimodal vision-LLM path. It analyzed Groq Llama-4 Scout as the candidate provider. The final implementation went with **Vertex AI Gemini 2.5 Flash** instead (per `plan.md`). The portrait-craft findings (FIQA literature, lighting patterns, Duchenne dependency, Hurley vocabulary) are still accurate — only the provider-specific sections (A.3 "Cloud vision architecture", A.4 Groq sources) are obsolete.

Research pass on portrait image metrics. What the literature says, what Portrait Coach currently gets right/wrong, what to change in the text-only path, and how to wire in a cloud vision API.

### A.1 What the literature says

**Face Image Quality Assessment (FIQA) is a solved research area, but for *biometric utility*, not *portrait aesthetics*.** Modern FIQA methods — SER-FIQ, SDD-FIQA, MagFace, CR-FIQA, CLIB-FIQA — all score faces against downstream face-recognition performance, not "is this a flattering headshot." Generic no-reference IQA metrics like BRISQUE/NIQE correlate only weakly with either face recognition or perceptual face quality. None of these is a drop-in for what Portrait Coach is trying to do. You'd use FIQA to reject unusable input (too blurry/off-angle to even analyze), not to coach a photographer.

**ISO/IEC 29794-5:2025** (the current face-quality standard) decomposes face quality into illumination, pose, and focus — and the reference implementations measure those via facial *symmetry* (Gabor wavelets) for illumination/pose, and *DCT* (discrete cosine transform) energy for focus. Not variance of Laplacian. This is a useful hint: the standards body prefers frequency-domain metrics over pixel-domain.

**Sharpness: Laplacian variance is OK-but-crude.** Literature consensus: Laplacian variance correlates decently with "focused vs blurry" on clean images but is sensitive to content (high-texture faces look "sharper" than low-texture faces at the same true focus). CPBD (Cumulative Probability of Blur Detection) is the perceptually-calibrated no-reference metric that tracks human blur judgment well, with *lower* compute cost than competing metrics. For face crops specifically, NIMA-technical (Google's CNN on AVA-technical) is the best-correlated single-number metric but requires a model download (MobileNet ~17MB).

**Duchenne smile — the important finding that changes the code.** The 2020 paper "Reconsidering the Duchenne Smile" found that **AU6 and AU12 are not independent** — high AU12 intensity automatically pulls AU6 up, even without felt positive emotion. So the classical "AU6 above threshold AND AU12 above threshold" test is essentially a proxy for *intensity of AU12*, not for genuineness. Practical implication: a Duchenne-positive result is really an intense-smile result. Don't overclaim.

**Lighting ratios and patterns have hard photographic definitions.** Loop: key light 30–45° off camera axis, above eye level. Butterfly: on-axis, above. Rembrandt: 45–60° side, high enough to throw a triangle of light on the shadow cheek *no wider than the eye and no longer than the nose*. Classical ratios in stops: 1:1 (flat), 2:1 (subtle), 3:1 (standard portrait), 4:1 (dramatic), 8:1+ (harsh). These map to luma ratios of 1.0, 1.4, 1.7, 2.0, 2.8+. Current "flat < 1.15, harsh > 5.0" thresholds are reasonable but the middle range needs better descriptions.

**Composition rules** for headshots (actor headshots, corporate portraits): eyes on the upper-third horizontal line; this often means cropping the top of the head, which is acceptable. Face-to-frame ratio isn't rigidly quantified in the literature but practitioners converge on "face + a bit of neck" for a tight headshot and "head fills ~60% of vertical frame height" for the standard.

**Peter Hurley's actual quantified rules**: (1) subject's jaw extended forward — not "down" — to eliminate the neck-chin blend; (2) "squinch" = raise lower eyelid only, narrowing distance from lower lid to pupil; (3) "tilt" = vertical head rotation, "turn" = horizontal — and he uses the words that precisely so he can direct subjects. Useful vocabulary to borrow in the tip text.

**Groq Llama-4 vision is production-ready.** Llama 4 Scout (17B activated / 109B total MoE, native multimodal) is on GroqCloud via the standard OpenAI-compatible chat/completions endpoint. Limits: 20 MB image size, 33 MP resolution, up to 5 images per request. Supports both `image_url` (URL) and base64 data URLs. Scout is the cheap/fast option; Maverick (400B) is the higher-quality one.

### A.2 Text-only path changes (do now)

Prioritized by impact-per-minute. Pure synthesizer.js + analysis.js tweaks, no new dependencies.

**1. Replace Laplacian-variance sharpness with something content-normalized** *(medium effort, high impact)*
The current `faceQualityScore` is sensitive to face content — bearded faces and high-texture skin look "sharper" than clean cheeks at identical focus. Two cheap fixes without pulling in CPBD:
- **Normalize Laplacian variance by local luma variance in the same region.** `faceQualityScore = sqrt(sum_lap² / sum_luma_var)`. This cancels most content-sensitivity.
- **Or**: measure sharpness only on high-contrast edges (eye-region eyelash/iris) rather than the full face. The eyes ARE what needs to be sharp in a portrait, so the eye-region Laplacian on the near eye is more photographically relevant. **Promote `nearEyeSharpness` to be `faceQualityScore`** and treat the full-face Laplacian as a cheap sanity check only.

**2. Decouple the Duchenne signal from its misleading name** *(trivial)*
Rename internally from `isDuchenneSmile` to `isIntenseSmile` (keep the external field name for back-compat). The coaching tip should say "that's a full, intense smile — nicely engaged" rather than claiming "genuine" vs "posed," which the literature shows we can't actually distinguish from AU6+AU12 alone.

**3. Add lighting-pattern descriptions that match the photographic standard** *(trivial, text-only)*
Current tips mention "butterfly/loop/Rembrandt" as labels but don't tell the user *what the fix is when the pattern is wrong*. Add one-line actionable directions per pattern detected. E.g., "Your light is at 2 o'clock and creates loop lighting — classic and flattering. To push toward Rembrandt (more dramatic), move the light another 15° to your side."

**4. Use "lit-side luma / shadow-side luma" expressed in *stops*** *(trivial)*
Photographers think in stops, not ratios. A 1.7 ratio is a 3:1 light, which is `log2(1.7) ≈ 0.77 stops of differential`. Rewrite the lighting ratio tip to say "shadow side is ~1 stop darker than the lit side — that's a standard, flattering 2:1 ratio."

**5. Lead room / horizontal offset** *(trivial, small fix)*
Current rule fires on `horizontalOffset > 0.3` combined with gaze direction. Photographic convention: "leave negative space in the direction of the gaze" only kicks in when offset exceeds ~0.2 in the *wrong* direction. Check sign handling.

**6. Add a "cropped top of head" exception** *(trivial)*
Pro headshots frequently crop the top of the hair to put eyes on the upper-third line — this is *correct*, not a "crown clipped" error. Gate the "crown clipped" tip on `eyelineYPosition > 0.40` (if eyes are already past the upper third, don't complain about the crown).

**7. Background tips using subject-separation contrast** *(small change)*
Current metric is just average brightness of the strip region. Add a cheap second metric: `|face mean luma − background mean luma|` normalized. High contrast = good separation; low contrast = subject blends in.

**8. Exposure using face-region EV, not full-image EV** *(small change)*
`computeExposureEV` currently samples the whole image. Change to sample only the face rectangle. Face-metered EV is what's photographically relevant — if the face is well-exposed and the background is dark, current logic calls the *whole image* underexposed, which is wrong for low-key portraits.

**9. Headroom tip wording** *(trivial)*
Change from "Excessive headroom" to "There's a lot of space above the head — most pro headshots crop tighter so the eyes land on the upper-third line." Reframes as constructive rather than scolding.

### A.3 Cloud vision architecture

**Division of labor:** on-device pipeline does what it's good at (**geometric measurements** — landmarks → angles, framing ratios, crop points, headroom). Cloud model does what *it's* good at (**perceptual judgment** — is this lighting flattering? does the expression feel natural? is the background distracting?).

```
┌─────────────────── client (browser) ─────────────────┐
│ MediaPipe → metrics {yaw, pitch, framing, crop, ...} │
│ Canvas → face crop JPEG, max 1024px long edge        │
│ EXIF strip, downscale                                │
└──────────────┬────────────────────────────────────────┘
               │  POST /onframe/api/analyze-vision
               │  { summary: "Head yaw: -5° …",
               │    imageB64: "data:image/jpeg;base64,…" }
               ▼
┌─────────────────── web-server (Node) ────────────────┐
│ Validate summary length + image size                 │
│ Rate-limit                                           │
│ Forward to Groq llama-4-scout with multipart prompt  │
└──────────────┬────────────────────────────────────────┘
               │
               ▼
          Groq llama-4-scout
          returns JSON: { cards, overallScore, aiSummary }
```

**Privacy-by-design:**
1. Crop to face bbox + 30% padding — removes location context, clothing details, and most re-identification context.
2. Downscale to 1024×1024 max (Llama-4 supports up to 33 MP; 1024 is plenty for coaching judgments).
3. Strip EXIF (GPS, timestamp, device) before base64 encoding.
4. Don't store the image server-side — Express proxy forwards and discards.
5. State the privacy model plainly in the UI: "Your cropped face is sent to the coaching AI for analysis. It's not stored anywhere."
6. Groq's API terms commit to no training on customer data but do not provide explicit zero-retention mode like Anthropic enterprise — acceptable but worth mentioning.
7. Browser fetch with `credentials: 'omit'` and no cookies on the analyze endpoint.

**Prompt design for Llama-4 Scout:** two-message structure. System prompt defines task and output schema; user message contains both metrics text summary AND face image as `image_url`.

```json
{
  "model": "meta-llama/llama-4-scout-17b-16e-instruct",
  "response_format": { "type": "json_object" },
  "temperature": 0.3,
  "max_tokens": 1400,
  "messages": [
    { "role": "system", "content": "<portrait coach system prompt>" },
    { "role": "user", "content": [
      { "type": "text", "text": "<text metrics summary>" },
      { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,…" } }
    ]}
  ]
}
```

**System prompt must do four things:**
1. Define the persona (professional portrait coach, plain-language, no jargon).
2. Instruct the model to **trust the geometric metrics** (yaw, pitch, framing) and **judge the perceptual things** (lighting quality, expression, background, style).
3. Enforce the exact output JSON schema with 6 categories, scores, titles, tips, `gearNeeded` array.
4. Ban specific jargon (Rembrandt, Duchenne, orbicularis, clock positions, f-stops) — whitelist everyday words.

**Key prompt move:** tell the model that the geometric metrics are authoritative and it should NOT override them. "The headYaw, pitch, and framingRatio are measured from face landmarks and are ground truth. Do not say 'your head is turned' if headYaw is 2°." Otherwise vision models hallucinate positional claims that contradict the measurements.

**Output schema:**
```json
{
  "overallScore": 78,
  "aiSummary": "2-3 sentences of plain-language assessment",
  "cards": [
    {
      "category": "Lighting",
      "score": 82,
      "title": "Warm, flattering light",
      "tip": "plain-language coaching",
      "gearNeeded": ["softbox"]
    }
  ]
}
```

Keep the client-side synthesizer.js as a **fallback path** when the cloud fails or the user is offline. Both paths produce the same card shape, so renderResults already works for either.

**Practical wiring changes:**
1. `web-server/server.js`: add a new route `/onframe/api/analyze-vision` that accepts `{ summary, imageB64 }`, validates sizes (< 1.5 MB base64 after crop), calls Llama-4-Scout with the multipart message. Keep existing `/api/analyze` as fallback.
2. `web/cloud.js`: add `fetchCloudCoachingWithImage(metrics, croppedBlob)`. Existing `fetchCloudCoaching(metrics)` stays for text-only fallback.
3. `web/analysis.js`: export `cropFaceImage(canvas, faceRect)` helper that returns a JPEG Blob of face + padding at ~1024 px max. Do this **before** `clearImageData` so canvas is still available.
4. `web/app.js`: try vision path first, fall back to text-only on failure.

**Cost and rate-limiting:** Llama-4 Scout on Groq is very cheap (~$0.20/M input, $0.60/M output; vision adds ~400 input tokens per image at 1024 px). A single coaching call is ~1500 input + 800 output tokens + 1 image = well under $0.001. Rate-limit vision endpoint at 10/minute per IP and add a daily per-IP cap.

**Calibration / evaluation path** (no training needed):
1. Keep the 6-sample gallery as a **regression set**. `/tmp/analyze_samples.mjs` runs the full pipeline and dumps per-metric output.
2. After any change, re-run regression and eyeball scores against visual assessment.
3. For more rigor: download 20-30 FFHQ images (CC-BY-NC), label 1–5 yourself. Aim for Spearman correlation > 0.7 between labels and overall score.
4. NIMA-technical pretrained weights run in TensorFlow.js (~17 MB) as a silent second-opinion sharpness/exposure metric.

**What NOT to do:**
- Don't replicate SER-FIQ or MagFace client-side — biometric-utility scores, not portrait-aesthetic scores.
- Don't use NIQE/BRISQUE — weakly correlated with both face recognition and perceptual face quality.
- Don't run NIMA-aesthetic client-side as primary score — perceptual judgment is better done by the vision LLM, which can also explain its reasoning in coaching text.

### A.4 Sources

- [Face Image Quality Assessment: A Literature Survey (ACM)](https://dl.acm.org/doi/fullHtml/10.1145/3507901)
- [CLIB-FIQA (CVPR 2024)](https://openaccess.thecvf.com/content/CVPR2024/papers/Ou_CLIB-FIQA_Face_Image_Quality_Assessment_with_Confidence_Calibration_CVPR_2024_paper.pdf)
- [SDD-FIQA (CVPR 2021)](https://openaccess.thecvf.com/content/CVPR2021/papers/Ou_SDD-FIQA_Unsupervised_Face_Image_Quality_Assessment_With_Similarity_Distribution_Distance_CVPR_2021_paper.pdf)
- [ISO/IEC 29794-5:2025 — Face image data quality](https://www.iso.org/standard/81005.html)
- [Face image quality evaluation for ISO/IEC 19794-5 / 29794-5](https://nlpr.ia.ac.cn/mmc/homepage/jtsang2/pdf/ICB2009.pdf)
- [CPBD (ASU)](https://ivulab.asu.edu/software/cpbd/) · [CPBD paper (IEEE)](https://ieeexplore.ieee.org/document/5246972/)
- [NIMA: Neural Image Assessment (Google Research)](https://research.google/blog/introducing-nima-neural-image-assessment/) · [NIMA paper (arXiv 1709.05424)](https://arxiv.org/pdf/1709.05424) · [idealo/image-quality-assessment](https://github.com/idealo/image-quality-assessment)
- [Reconsidering the Duchenne Smile: AU6/AU12 dependency (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC7193529/)
- [Automated detection of smiles as discrete episodes (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC9828522/)
- [FACS (Wikipedia, AU6/AU12)](https://en.wikipedia.org/wiki/Facial_Action_Coding_System)
- [SLR Lounge — 5 Common Key Light Patterns](https://www.slrlounge.com/common-key-light-patterns/)
- [Digital Photography School — 6 Portrait Lighting Patterns](https://digital-photography-school.com/6-portrait-lighting-patterns-every-photographer-should-know/)
- [Peter Hurley — Mastering the Squinch](https://peterhurley.com/blog/2013/who-knew-it-really-all-about-squinch) · [SLR Lounge — Secret to a Strong Headshot](https://www.slrlounge.com/small-adjustment-big-impact-secret-strong-headshot-peter-hurley/)
- [Zack Sutton — Why I Crop My Headshot Photography The Way I Do](https://zsuttonphoto.com/crop-headshot-photography-way/)
- [Digital Photography School — Rule of Thirds](https://digital-photography-school.com/rule-of-thirds/)
- [Groq Docs — Images and Vision](https://console.groq.com/docs/vision) · [Llama 4 Scout model](https://console.groq.com/docs/model/meta-llama/llama-4-scout-17b-16e-instruct) · [Llama 4 on GroqCloud blog](https://groq.com/blog/llama-4-now-live-on-groq-build-fast-at-the-lowest-cost-without-compromise)
- [LearnOpenCV — BRISQUE](https://learnopencv.com/image-quality-assessment-brisque/) · [NIQE paper (UT Austin LIVE)](http://live.ece.utexas.edu/research/Quality/niqe_spl.pdf)

---
