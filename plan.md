# OnFrame — Photo Coaching App

> AI-powered photo coaching that analyzes lighting, pose, composition, sharpness, expression, and more. Offline mode stays fully on-device; cloud mode uploads a reduced photo for higher-quality coaching.

## Current State (2026-04-12)

### Architecture
- **Frontend**: Vanilla JS SPA, Vite build (minified), served by nginx
- **Analysis**: MediaPipe FaceLandmarker (478 face points) + PoseLandmarker (33 body points), all client-side WASM
- **Synthesis**: Rules-based scoring engine (`synthesizer.js`) with 6 coaching categories
- **Cloud mode**: Current implementation sends text-only metric summaries to the server. Planned next step is Gemma-based vision augmentation, not a second scoring engine.
- **Privacy**: Offline mode is zero-upload. Planned cloud mode uploads a reduced photo transiently for AI analysis and does not store it after the request.

### Completed Enhancements (this session)

#### Photo Type Detection
- Classifies photos as close-up, head & shoulders, half-length, three-quarter, or full-length
- Based on face-to-frame ratio (`faceFramingRatio`)
- Composition coaching adjusts per type (eyeline thresholds, crop rules, headroom)
- Type label shown below score in results

#### Body Pose Detection (Phase 2 Metrics)
- Added MediaPipe PoseLandmarker (lite, 5.5MB) alongside FaceLandmarker
- Detects shoulders, elbows, wrists, hips, knees, ankles
- New coaching signals:
  - Knee crop detection (-15 pts)
  - Ankle crop detection (-12 pts)
  - Wrist crop detection (-8 pts)
  - Square shoulders detection (-5 pts for wider shots)
  - High camera angle detection (foreshortened legs warning)

#### Background Blur / Subject Isolation
- Compares face Laplacian variance vs background Laplacian variance
- Ratio < 1.5: suggests Portrait Mode
- Ratio > 3.0: rewards good separation

#### Expression Tension Detection
- Detects brow furrow via blendshapes (`browDownLeft/Right`)
- Detects jaw clench via blendshapes (`mouthPressLeft/Right`)
- Coaches to relax forehead and jaw

#### Face Tonal Range
- Detects blown highlights (>5% face pixels at 248+)
- Detects crushed shadows (>8% face pixels below 8)
- Suggests tapping face for exposure

#### Sharpness Recalibration
- Fixed always-100 sharpness scores (divisor was 80, changed to 500)
- Now matches Python analyzer calibration: sharp 0.6-0.9, soft 0.2-0.5, blurry <0.2

#### Headroom Fix
- Accounts for hair above forehead (20% face height offset)
- Prevents false "excessive headroom" on hairstyles like buns

#### Coaching Text Overhaul
- Removed all jargon ("focus contrast", "lighting ratio", "workable range")
- Beginner-friendly language throughout
- Lighting tips work for sun AND indoor light ("turn toward the light" not "move the light source")
- Removed "📱 Mobile tip" labels — camera advice integrated into main tips
- Varied quick-take summaries with randomization
- Background tip no longer praises dark-ish backgrounds inappropriately

#### UI/UX Improvements
- **OnFrame rebrand** from Portrait Coach (renamed from portrait-fix, all references updated)
- **Mobile-first layout** — 430px max-width on all screens, even desktop
- **Results overlay** — full-viewport fixed overlay with photo + bottom sheet
- **Photo hotspot pins** — color-coded pins (green/yellow/red) positioned outside face, with SVG leader lines to face landmarks
- **Pin positioning** — avoids back-button zone, sharpness anchors to left eye, not dead center
- **Swipeable card carousel** — CSS scroll-snap, cards sorted worst-first (red → yellow → green)
- **Bottom sheet** — draggable via handle + header area, 3 snap points (collapsed/half/full), defaults to half
- **Carousel dots** — synced with scroll position, active card's pin pulses
- **Offline/Cloud mode toggle** — color-coded (green/blue, 10% tint), below value prop
- **Privacy note** — left-aligned, updates per mode
- **Browser back button** — returns to upload, clears all data, no forward re-entry
- **Report issue** — auto-expands sheet, cancel resizes back down
- **Thank-you screen** — shown after report with reference ID and back link
- **Error reporting** — stage tracking, stack traces, device info in report payload
- **No-face error** — friendlier message encouraging retry
- **12 diverse samples** — close-up through three-quarter, diverse subjects
- **Photo type label** shown in results header

#### Security & Production Hardening
- **Self-hosted MediaPipe** — removed cdn.jsdelivr.net dependency, tightened CSP
- **Vite minification** — scoring algorithm obfuscated in production build
- **Server response validation** — whitelist AI response fields, cap lengths
- **Health endpoint** — no longer leaks AI provider config
- **Error messages** — no file metadata or stack traces
- **Blob URL cleanup** — fixed leak on image load error
- **PoseLandmarker graceful degradation** — wrapped in try-catch
- **Init failure recovery** — resets both landmarkers on partial failure
- **Concurrency guard** — prevents race condition on rapid uploads
- **File size limit** — 20 MB client-side check
- **Min image size** — rejects < 10x10px
- **Camera permission** — Permissions-Policy changed to `camera=(self)`
- **Security headers** on model/WASM paths (were stripped by nginx location blocks)
- **ARIA live regions** on analyzing/error panels
- **Cache strategy** — no-cache HTML, immutable hashed assets

#### Infrastructure
- Dockerfile builds Vite dist + downloads both models at build time
- nginx serves dist/ (minified) not source
- Dead CSS removed (~40 lines), dead DOM refs removed
- Performance: luma function hoisted out of pixel loop

### Scoring Categories & Weights

| Category | Weight | Key Signals |
|----------|--------|-------------|
| Lighting | 0.30 | Catchlights, ratio, broad/short, color cast, exposure, skin smoothness, highlight/shadow clipping |
| Head Angle & Pose | 0.25 | Yaw (3/4 vs frontal), pitch (camera height), roll (tilt), type-aware |
| Composition & Framing | 0.20 | Eyeline, face framing, headroom, crop safety (face + body joints), centering, lead room |
| Sharpness & Focus | 0.15 | Laplacian variance on face + eyes, near-eye for 3/4 views |
| Background | 0.05 | Brightness, subject isolation (blur ratio) |
| Eye Contact & Gaze | 0.05 | Squinch, Duchenne smile, wide eyes, scleral show, brow/jaw tension |

### Planned / Next

#### Cloud Mode — Gemma-Based Vision Augmentation

**Model choice**
- Use **Gemma on Vertex AI Model Garden** only.
- Gemma is used for **multimodal perceptual judgment**: text + image input, text output.
- No Groq path, no provider fallback, no parallel AI stacks.

**Design goal**
- Keep **deterministic scoring local-first**.
- Use Gemma only for the judgments that local heuristics are weak at:
  - whether lighting feels flattering vs merely measurable
  - whether expression reads natural, tense, warm, awkward, confident
  - whether background distractions are perceptually salient
  - whether the portrait "reads" well overall despite acceptable raw metrics
- Do **not** move geometry- or pixel-derived scoring into the model:
  - face framing
  - headroom
  - crop safety
  - body crop issues
  - sharpness metrics
  - exposure/clipping
  - landmark-derived pose

**Source of truth**
- Local analysis always runs first.
- Local analysis remains authoritative for all raw metrics and base category scores.
- Gemma returns **perceptual findings** and **bounded score adjustments**, not the final cards schema.
- Server merges local output + Gemma output and recomputes final overall score deterministically.

**Image input**
- For best coaching quality, send a **single reduced full-frame photo** to Gemma.
- Client responsibilities:
  - downscale aggressively before upload
  - strip EXIF/metadata
  - encode as compressed JPEG or WebP
- Server responsibilities:
  - hold image bytes in memory only
  - never write the image to disk
  - never include image bytes in logs, reports, or analytics payloads

**Why full photo wins on quality**
- Gemma can judge the actual frame instead of proxies.
- This improves:
  - `Composition & Framing`
  - `Background`
  - scene-level lighting judgment
  - the overall "does this photo read well?" assessment
- It also unlocks stronger future features:
  - best-of-N photo selection
  - platform-specific coaching
  - scene-aware recommendations

**Category ownership**
- `Lighting`: local base score + optional bounded Gemma adjustment
- `Head Angle & Pose`: local-owned base score; Gemma may add phrasing and a small bounded adjustment only when the full frame materially changes the perceptual read
- `Composition & Framing`: local base score + optional bounded Gemma adjustment
- `Sharpness & Focus`: local-owned only
- `Background`: local base score + optional bounded Gemma adjustment
- `Eye Contact & Gaze`: local base score + optional bounded Gemma adjustment

**Adjustment rules**
- Gemma may adjust `Lighting`, `Composition & Framing`, `Background`, and `Eye Contact & Gaze`.
- Gemma may adjust `Head Angle & Pose` only within a smaller cap.
- Suggested per-category delta caps:
  - `Lighting`, `Composition & Framing`, `Background`, `Eye Contact & Gaze`: `-10` to `+10`
  - `Head Angle & Pose`: `-5` to `+5`
- No Gemma-provided overall score is trusted directly.
- Final overall score is recomputed server-side from final merged category scores.
- If Gemma output is malformed or missing, return local results with either:
  - no AI summary, or
  - a degraded/fallback AI summary generated from local results only

**Privacy & product disclosure**
- Offline mode copy:
  - "Your photo stays on this device. Analysis runs locally in your browser."
- Cloud mode copy:
  - "A reduced version of your photo and a measurement summary are sent to our AI service for higher-quality coaching. The app does not store the image after analysis."
- The top-level product copy must never claim "photos never leave the device" without qualifying that this is true only in offline mode.

**Request contract**
- New route: `POST /onframe/api/analyze-vision`
- Request body:
  - `summary`
  - `photoType`
  - `localScores`
  - `imageB64`

Example request:

```json
{
  "summary": "Measured portrait summary...",
  "photoType": "head-and-shoulders",
  "localScores": {
    "lighting": 68,
    "headpose": 74,
    "composition": 81,
    "sharpness": 77,
    "background": 60,
    "eyecontact": 72
  },
  "imageB64": "<base64>"
}
```

**Gemma response contract**
- Gemma should return:
  - `aiSummary`
  - `perceptualFindings`
- It should **not** return the final app card schema directly.

Example response:

```json
{
  "aiSummary": "The expression feels engaged and natural, but the portrait still reads a little flat because the light is even without much shape.",
  "perceptualFindings": {
    "lighting": {
      "delta": -6,
      "reason": "Light is technically even but reads flat across the face."
    },
    "composition": {
      "delta": -5,
      "reason": "The framing feels cramped at the top and too centered overall."
    },
    "background": {
      "delta": -4,
      "reason": "Bright background detail competes with the face."
    },
    "eyecontact": {
      "delta": 5,
      "reason": "The expression reads engaged and believable."
    }
  }
}
```

**Merge strategy**
1. Client runs local analysis and computes base result.
2. If cloud mode is enabled, client sends a reduced full-frame image + local summary + local category scores.
3. Server calls Gemma.
4. Server validates Gemma output and clamps all deltas.
5. Server merges Gemma adjustments into eligible categories only.
6. Server recomputes final overall score from category weights.
7. Server returns the existing result schema plus `aiSummary`.

**Failure strategy**
- No Groq fallback.
- If Gemma call fails:
  - return the local result immediately
  - optionally attach a server-generated note that AI augmentation was unavailable
- This keeps cloud mode additive rather than a dependency for the core app.

**Implementation steps**
1. Add Vertex AI credentials/config to the deployment environment.
2. Add a Gemma client in `web-server/` for multimodal inference.
3. Create `POST /onframe/api/analyze-vision` with strict request-size limits and JSON validation.
4. Client-side: generate a reduced full-frame `imageB64` from the already-loaded image, strip EXIF, and downscale aggressively.
5. Add a server-side merge layer that converts Gemma perceptual findings into bounded adjustments.
6. Keep the existing text-summary cloud path only as a temporary migration aid if needed, but the target architecture is full-photo Gemma only.
7. Update mode disclosure text and analytics/report payload sanitization so no image bytes are logged or included in issue reports.

**Testing plan**
- Request validation tests:
  - missing `summary`
  - missing `imageB64`
  - oversized body
  - invalid base64
- Merge tests:
  - allowed categories can move within capped deltas
  - disallowed categories ignore Gemma deltas
  - malformed Gemma output falls back to local result
- Privacy tests:
  - report endpoint never accepts or logs image data
  - server logs contain request metadata only, never image bytes
- UI tests:
  - offline disclosure text vs cloud disclosure text
  - cloud failure still shows usable local coaching

**Rollout**
- Phase 1: Gemma generates `aiSummary` only.
- Phase 2: bounded Gemma adjustments for `Lighting`, `Composition & Framing`, `Background`, and `Eye Contact & Gaze`.
- Phase 3: optional bounded `Head Angle & Pose` adjustments, prompt tuning, and evaluation set for perceptual consistency before broad rollout.

#### Future Enhancements
- **Progress tracking** — localStorage history of scores over time
- **Share results** — generate image card for social sharing
- **Annotated photo overlay** — rule-of-thirds grid, eyeline guide, catchlight circles
- **Compare two photos** — side-by-side scoring
- **Platform context** — LinkedIn/Instagram/Dating/Passport adjusts weights
- **Lighting pattern names** — classify loop/Rembrandt/butterfly from shadow analysis
- **Skin tone accuracy** — Lab color space I-line check
- **Offline PWA** — service worker for full offline support
- **Before/after** — show reference photo for weakest category

### File Structure
```
onframe/
  web/
    index.html          — SPA entry point
    app.js              — State machine, UI rendering, event handlers
    analysis.js         — MediaPipe face + pose detection, pixel analysis
    synthesizer.js      — Rules-based scoring engine (6 categories)
    composition.js      — Pure geometry helpers (headroom, photo type)
    cloud.js            — Cloud mode API client
    style.css           — Dark theme, responsive layout
    mediapipe/          — Self-hosted vision_bundle.mjs + WASM
    models/             — face_landmarker.task + pose_landmarker_lite.task
    sample/             — 12 sample photos
    __tests__/          — Vitest test suite
  web-server/
    server.js           — Express API for cloud mode
    __tests__/          — Server test suite
```

### Test Coverage
- `web/__tests__/synthesizer.test.js` — 57 tests (scoring, coaching text, photo type, summary)
- `web/__tests__/analysis.test.js` — 8 tests (headroom, photo type classification)
- `web-server/__tests__/server.test.js` — 13 tests (API endpoints, rate limiting, validation)
- **Total: 86 tests** — run with `npx vitest run` from `onframe/`
