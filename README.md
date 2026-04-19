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

**Privacy-first:** In offline mode, photos never leave your browser. All analysis runs locally in the browser via WASM.

## Tech Stack

- **Frontend:** Vanilla JS ES modules, Vite build
- **Face detection:** MediaPipe FaceLandmarker + PoseLandmarker (WASM, client-side)
- **Backend:** Node.js + Express (Groq API proxy for cloud mode only)
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
- Cloud mode sends only text metrics (no images) to a third-party AI service

## License

This project is shared for educational and reference purposes. You may study, fork, and learn from the code. Commercial use, redistribution, or derivative works require explicit permission from the author.
