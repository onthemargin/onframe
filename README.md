# OnFrame

AI-powered portrait photo coaching — analyzes lighting, pose, composition, sharpness, background, and expression from a single photo.

**Live:** https://app.gyatso.me/onframe/

> **Experimental / Educational purposes only.** This is a personal project for learning and experimentation with browser-based computer vision (MediaPipe), client-side image analysis, and interactive UI design. Not intended for production use.

---

**Author:** [On The Margin](https://onthemargin.io)
**Built with:** [Claude Code](https://claude.ai/code) — Anthropic's interactive CLI tool

## How it works

1. Upload or take a portrait photo (or try a sample)
2. On-device MediaPipe face + pose detection extracts 478 face landmarks and 33 body points
3. Canvas pixel analysis measures lighting ratio, catchlights, sharpness, color cast, exposure, and more
4. Rules-based scoring engine produces 6 coaching cards with specific feedback
5. Results shown as an interactive overlay with hotspot pins on the photo

**Privacy:** Local MediaPipe face/pose analysis runs on-device. OnFrame doesn't retain your photo — it's forwarded to Google Vertex AI in-memory for coaching and discarded after the response. Google's handling of the request is governed by [Vertex AI data governance](https://cloud.google.com/vertex-ai/generative-ai/docs/data-governance).

## Tech Stack

- **Frontend:** Vanilla JS ES modules, Vite build
- **Face detection:** MediaPipe FaceLandmarker + PoseLandmarker (WASM, client-side)
- **Backend:** Node.js + Express (multipart proxy to Gemini 2.5 Flash on Vertex AI)
- **Hosting:** Google Cloud Run via nginx + supervisord

## Scoring Categories

| Category | Weight |
|----------|--------|
| Lighting | 0.30 |
| Head Angle & Pose | 0.25 |
| Composition & Framing | 0.20 |
| Sharpness & Focus | 0.15 |
| Background | 0.05 |
| Eye Contact & Gaze | 0.05 |

## Disclaimers

- This is an **experimental project** created for educational and personal learning purposes
- Not intended as professional photography advice
- No warranty of accuracy or fitness for any purpose
- The scoring algorithms are heuristic-based and may not reflect professional photographic standards
- OnFrame doesn't retain photos. They're sent to Google Vertex AI (Gemini 2.5 Flash) and discarded after the response — see [Google's Vertex AI data governance](https://cloud.google.com/vertex-ai/generative-ai/docs/data-governance) for how Google handles the request

## License

This project is shared for educational and reference purposes. You may study, fork, and learn from the code. Commercial use, redistribution, or derivative works require explicit permission from the author.
