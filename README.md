# OnFrame

AI-powered portrait photo coaching — analyzes lighting, pose, composition, sharpness, background, and expression from a single photo.

**Live:** https://app.gyatso.me/onframe/

> **Experimental / Educational purposes only.** This is a personal project for learning and experimentation with browser-based computer vision (MediaPipe), client-side image analysis, and interactive UI design. Not intended for production use.

---

**Author:** [On The Margin](https://onthemargin.io)
**Built with:** [Claude Code](https://claude.ai/code) — Anthropic's interactive CLI tool

## How it works

1. Upload or take a portrait photo (or try a sample)
2. On-device MediaPipe face + pose detection extracts 478 face landmarks and 33 body points (used for the overlay pins and as geometric grounding)
3. The downscaled photo + local geometry are sent to Google Vertex AI (Gemini 2.5 Flash), which scores all 6 categories 0–100 with a specific tip each
4. If Vertex is unavailable, an on-device heuristic synthesizer produces the cards as a fallback — the app still works fully offline
5. Results render as interactive coaching cards with hotspot pins on the photo

Sample photos use a pre-computed coaching cache (`web/sampleCoaching.data.json`); only your own uploads call Vertex.

**Privacy:** Local MediaPipe face/pose analysis runs on-device. OnFrame doesn't retain your photo — it's forwarded to Google Vertex AI in-memory for coaching and discarded after the response. Google's handling of the request is governed by [Vertex AI data governance](https://cloud.google.com/vertex-ai/generative-ai/docs/data-governance). If you tap "Report an issue," a diagnostic record (scores, coarse device info, and any text you type — never the photo or its filename) is written to server logs so the problem can be traced.

## Tech Stack

- **Frontend:** Vanilla JS ES modules, Vite build
- **Face detection:** MediaPipe FaceLandmarker + PoseLandmarker (WASM, client-side)
- **Backend:** Node.js + Express. Scores the photo via Gemini 2.5 Flash on Vertex AI and also serves the built frontend (single self-contained process).
- **Hosting:** runs standalone as one Node container (see below), or at `/onframe` inside the [app.gyatso.me](https://app.gyatso.me) monorepo via nginx + supervisord.

## Scoring Categories

Gemini scores all six 0–100; the weighted overall uses:

| Category | Weight |
|----------|--------|
| Lighting | 0.30 |
| Head Angle & Pose | 0.25 |
| Composition & Framing | 0.20 |
| Sharpness & Focus | 0.15 |
| Background | 0.05 |
| Eye Contact & Gaze | 0.05 |

## Run it

**Local dev** (frontend + API with hot reload):

```bash
# terminal 1 — API on :3004
cd web-server && npm install && npm start
# terminal 2 — Vite dev server on :5173 (proxies /onframe/api → :3004)
cd web && npm install && npm run dev   # → http://localhost:5173/onframe/
```

**Single container** (production-style — Express serves the built frontend + API):

```bash
docker build -t onframe .
docker run -p 3004:3004 onframe        # → http://localhost:3004/onframe/
```

**Deploy to Google Cloud Run:**

```bash
gcloud run deploy onframe --source . --region us-central1 --allow-unauthenticated
# or use the included cloudbuild.yaml
```

**Enable AI coaching (optional).** Without Vertex configured the app falls back to on-device local coaching. To turn on Gemini scoring, set these and provide [Google ADC](https://cloud.google.com/docs/authentication/application-default-credentials):

| Env var | Purpose | Default |
|---|---|---|
| `VERTEX_PROJECT` | GCP project with Vertex AI enabled — **enables Gemini** | _(unset → local fallback)_ |
| `VERTEX_LOCATION` | Vertex region | `us-central1` |
| `VERTEX_MODEL` | model id | `gemini-2.5-flash` |
| `BASE_PATH` | path prefix before `/onframe` | _(empty)_ |
| `VITE_BASE` | build-time base for assets | `/onframe/` |
| `TRUST_PROXY` | proxy hops to trust for rate limiting | _(off)_ |
| `GLOBAL_RATE_MAX` | per-instance `/analyze` cap per minute | `120` |
| `STATIC_DIR` | dir of the built frontend Express serves | _(set by Docker)_ |

On Cloud Run, the runtime service account's ADC is used automatically — just grant it `roles/aiplatform.user` and set `VERTEX_PROJECT`.

## Eval harness

`eval/` (not shipped in the image) holds the quality tooling: absolute-score eval vs labels, a multi-model + cross-family jury, a controlled-degradation specificity test, and an external-dataset correlation harness. See `eval/README.md` and `eval/EXTERNAL-VALIDATION.md`.

## Disclaimers

- This is an **experimental project** created for educational and personal learning purposes
- Not intended as professional photography advice
- No warranty of accuracy or fitness for any purpose
- The scoring algorithms are heuristic-based and may not reflect professional photographic standards
- OnFrame doesn't retain photos. They're sent to Google Vertex AI (Gemini 2.5 Flash) and discarded after the response — see [Google's Vertex AI data governance](https://cloud.google.com/vertex-ai/generative-ai/docs/data-governance) for how Google handles the request

## License

This project is shared for educational and reference purposes. You may study, fork, and learn from the code. Commercial use, redistribution, or derivative works require explicit permission from the author.
