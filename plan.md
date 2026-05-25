# OnFrame — Photo Coaching App

> AI-powered photo coaching that analyzes lighting, pose, composition, sharpness, expression, and more. Local MediaPipe runs first to produce precise measurements; a reduced photo + metrics are then sent to Gemini on Vertex AI for perceptual coaching. Nothing is stored server-side.

## Current State (2026-05-17)

### Architecture
- **Frontend**: Vanilla JS SPA, Vite build (minified), served by nginx. Mobile-only (iPhone/iPad/Android phones); desktop visitors get a block message.
- **Local analysis**: MediaPipe FaceLandmarker (478 face points) + PoseLandmarker (33 body points), all client-side WASM. Produces deterministic measurements used as input to the AI.
- **AI coaching**: Gemini on Vertex AI (multimodal — text + image input, text output). Cloud-only — no offline-only mode.
- **Local synthesizer**: Rules-based scoring engine (`synthesizer.js`) is retained as a degraded fallback if the Vertex AI call fails. Not user-selectable.
- **Privacy**: Local MediaPipe analysis runs on-device. The photo + computed metrics are sent to OnFrame's server, forwarded to Vertex AI in-memory, and discarded as soon as the response is returned. Nothing is written to disk, logged, or retained.

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
- **Offline/Cloud mode toggle** — REMOVED. App is now cloud-only.
- **Privacy note** — single-mode copy: photo is sent to AI, not stored, discarded after response.
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

#### AI Coaching — Gemini on Vertex AI (cloud-only)

**Model choice**
- **Gemini 2.5 Flash on Vertex AI**, multimodal (text + image in, text out). Pay-per-call (no idle endpoint cost).
- No Groq, no offline AI path, no provider fallback, no parallel AI stacks.
- Vertex AI is reached from Cloud Run via the deployed service account; no API keys in env.

**Design goal**
- Local MediaPipe still runs first to produce precise, deterministic measurements (landmarks, sharpness variance, pose joints, exposure clipping, etc.). These are sent to Gemini as a measurement payload alongside the photo so the model doesn't have to estimate things the local code can compute exactly.
- Gemini owns the **perceptual layer**:
  - whether lighting feels flattering vs merely measurable
  - whether expression reads natural, tense, warm, awkward, confident
  - whether background distractions are perceptually salient
  - whether the portrait "reads" well overall despite acceptable raw metrics
- Geometry- and pixel-derived scoring (framing, headroom, crop safety, body crop issues, sharpness, exposure/clipping, landmark-derived pose) stays grounded in local metrics so scores stay stable across calls.

**Source of truth**
- Local MediaPipe analysis is authoritative for raw measurements.
- Gemini returns **perceptual findings** and **bounded score adjustments**, plus the user-facing `aiSummary`. It does not produce the final cards schema directly.
- Server merges local measurements + Gemini findings and recomputes the final overall score deterministically.

**Image input**
- For best coaching quality, send a **single reduced full-frame photo** to Gemini.
- Client responsibilities:
  - downscale aggressively before upload
  - strip EXIF/metadata
  - encode as compressed JPEG or WebP
- Server responsibilities:
  - hold image bytes in memory only
  - never write the image to disk
  - never include image bytes in logs, reports, or analytics payloads

**Why full photo wins on quality**
- Gemini can judge the actual frame instead of proxies.
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
- `Lighting`: local base score + optional bounded Gemini adjustment
- `Head Angle & Pose`: local-owned base score; Gemini may add phrasing and a small bounded adjustment only when the full frame materially changes the perceptual read
- `Composition & Framing`: local base score + optional bounded Gemini adjustment
- `Sharpness & Focus`: local-owned only
- `Background`: local base score + optional bounded Gemini adjustment
- `Eye Contact & Gaze`: local base score + optional bounded Gemini adjustment

**Adjustment rules**
- Gemini may adjust `Lighting`, `Composition & Framing`, `Background`, and `Eye Contact & Gaze`.
- Gemini may adjust `Head Angle & Pose` only within a smaller cap.
- Suggested per-category delta caps:
  - `Lighting`, `Composition & Framing`, `Background`, `Eye Contact & Gaze`: `-10` to `+10`
  - `Head Angle & Pose`: `-5` to `+5`
- No Gemini-provided overall score is trusted directly.
- Final overall score is recomputed server-side from final merged category scores.
- If Gemini output is malformed or missing, return local results with either:
  - no AI summary, or
  - a degraded/fallback AI summary generated from local results only

**Privacy & product disclosure**
- Single-mode copy on the upload screen:
  - "Your photo is sent to AI for coaching. We don't save it — it's processed in memory and discarded immediately after the response. Local face analysis still runs on your device."
- No copy anywhere in the app may claim "photos never leave the device" — that wording was tied to the now-removed offline mode.
- Server-side guarantees that back the copy:
  - photo bytes are held only in the request handler's memory
  - never written to disk (no `/tmp` staging, no caches)
  - never included in logs, error reports, or analytics payloads
  - request body discarded as soon as the response is sent
- Vertex AI handles the bytes per Google Cloud's Vertex AI data policy (Gemini in Model Garden). The privacy copy must be accurate about OnFrame's behavior without overclaiming Google's.

**Request contract**
- Route: `POST /onframe/api/analyze` (replaces the legacy text-only Groq route at the same path).
- Content-Type: `multipart/form-data` with two fields:
  - `photo` — JPEG, downscaled client-side to ≤ 1280px on the long edge, EXIF stripped
  - `metrics` — JSON blob: `{ summary, photoType, localScores }`

Example `metrics` field:

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
  }
}
```

**Gemini response contract**
- Gemini should return:
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
1. Client runs local MediaPipe analysis and computes base measurements + local card scores.
2. Client downscales the photo (≤ 1280px long edge, JPEG, no EXIF) and POSTs `photo` + `metrics` multipart to `/onframe/api/analyze`.
3. Server calls Vertex AI Gemini with the photo and a structured prompt that includes the measurement payload.
4. Server validates Gemini output, clamps all deltas to the per-category caps below, and discards the photo bytes.
5. Server merges Gemini adjustments into eligible categories only.
6. Server recomputes final overall score from category weights.
7. Server returns the existing result schema plus `aiSummary`.

**Failure strategy**
- If Vertex AI is unreachable, slow, returns malformed output, or hits a quota error: the server falls back to the **local synthesizer cards** computed from the metrics it just received (no second AI provider, no retry storm).
- Response includes a small `aiUnavailable: true` flag so the client can render a subtle "AI coaching unavailable — showing measured analysis" note above the cards.
- Local synthesizer stays in the bundle for exactly this reason; it is not user-selectable.

**Implementation steps**
1. Grant the Cloud Run service account `roles/aiplatform.user` on the project so Vertex AI is callable without API keys. Set `VERTEX_PROJECT`, `VERTEX_LOCATION`, `VERTEX_MODEL` (default `gemini-2.5-flash`) env vars on the service.
2. Add a Gemini Vertex client in `web-server/` (Google Cloud SDK or REST) that accepts `{ photoBuffer, metrics }` and returns `{ aiSummary, perceptualFindings }`. Caller never persists the buffer.
3. Replace the existing `POST /onframe/api/analyze` (Groq, text-only) with the new multipart route. Limits: total request ≤ 8 MB, photo ≤ 6 MB, `metrics` ≤ 16 KB. Use `multer` memory storage (no disk).
4. Client-side: add a downscale helper in `cloud.js` (canvas-based, JPEG quality 0.85, max edge 1280, strip EXIF by re-encoding) and switch `fetchCloudCoaching` to `FormData` POST with `photo` + `metrics`.
5. Add a server-side merge layer that converts Gemini `perceptualFindings.delta` values into clamped per-category adjustments and recomputes overall score.
6. Delete the offline/cloud mode toggle code and the text-only Groq path entirely. Remove `GROQ_API_KEY` references from server, env, and docs.
7. Update `index.html` privacy copy + ensure the `/report` endpoint sanitizer never accepts `photo` or `metrics` fields.

**Testing plan**
- Request validation tests:
  - missing `photo` part
  - missing `metrics` part
  - oversized photo (>6 MB)
  - oversized metrics (>16 KB)
  - non-image content type for `photo`
- Merge tests:
  - allowed categories can move within capped deltas
  - disallowed categories (sharpness) ignore Gemini deltas even if returned
  - malformed Gemini output falls back to local synthesizer with `aiUnavailable: true`
- Privacy tests:
  - photo buffer is not written to any tmp path during the request lifecycle
  - report endpoint never accepts or logs `photo`/`metrics` fields
  - server logs contain request metadata only, never image bytes
- UI tests:
  - upload screen shows the cloud-only privacy copy
  - `aiUnavailable: true` triggers the degraded coaching banner
  - successful cloud response renders `aiSummary` in the quick-take panel

**Rollout**
- Phase 1: Land the multipart route + downscale + Gemini client; render `aiSummary` only, no perceptual adjustments yet.
- Phase 2: Enable bounded Gemini adjustments for `Lighting`, `Composition & Framing`, `Background`, and `Eye Contact & Gaze`.
- Phase 3: Enable bounded `Head Angle & Pose` adjustments; build a perceptual-consistency evaluation set before opening it up.

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
    cloud.js            — Vertex AI Gemini API client (multipart photo + metrics)
    device.js           — Mobile-only device detection (matchMedia + maxTouchPoints)
    style.css           — Dark theme, responsive layout
    mediapipe/          — Self-hosted vision_bundle.mjs + WASM
    models/             — face_landmarker.task + pose_landmarker_lite.task
    sample/             — 12 sample photos
    __tests__/          — Vitest test suite
  web-server/
    server.js           — Express API: /api/analyze (multipart → Vertex Gemini), /api/report
    __tests__/          — Server test suite
```

### Test Coverage
- `web/__tests__/synthesizer.test.js` — scoring, coaching text, photo type, summary
- `web/__tests__/analysis.test.js` — headroom, photo type classification
- `web/__tests__/device.test.js` — mobile-only gate (matchMedia + maxTouchPoints)
- `web-server/__tests__/server.test.js` — API endpoints, rate limiting, validation
- **Total: 100 tests** as of 2026-05-17 — run with `npx vitest run` from `onframe/web-server/`
