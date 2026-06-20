# OnFrame — self-contained image. Builds the Vite frontend (with MediaPipe
# models + WASM) and runs the Express server, which serves BOTH the static
# frontend and the /onframe/api endpoints in a single process. No nginx needed.
#
#   docker build -t onframe .
#   docker run -p 3004:3004 onframe          # → http://localhost:3004/onframe/
#
# AI coaching is optional: set VERTEX_PROJECT (+ provide Google ADC) to enable
# Gemini scoring; without it the app falls back to on-device local coaching.

# ---- build frontend ----
FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache curl
COPY web/package*.json web/
RUN cd web && npm install --no-audit --no-fund
COPY web/ web/
# Bundle MediaPipe models + WASM into the build so the app is fully offline-capable.
RUN mkdir -p web/public/models web/public/mediapipe/wasm \
 && curl -fsSL -o web/public/models/face_landmarker.task \
      "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task" \
 && curl -fsSL -o web/public/models/pose_landmarker_lite.task \
      "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task" \
 && cp web/mediapipe/wasm/* web/public/mediapipe/wasm/
ARG VITE_BASE=/onframe/
RUN cd web && VITE_BASE="$VITE_BASE" npx vite build

# ---- server prod deps ----
FROM node:20-alpine AS server-deps
WORKDIR /app/web-server
COPY web-server/package*.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3004 \
    HOST=0.0.0.0 \
    BASE_PATH= \
    STATIC_DIR=/app/web/dist \
    VERTEX_LOCATION=us-central1 \
    TRUST_PROXY=1
COPY --from=server-deps /app/web-server/node_modules ./web-server/node_modules
COPY web-server/server.js web-server/vertex.js web-server/package.json ./web-server/
COPY --from=build /app/web/dist ./web/dist
EXPOSE 3004
CMD ["node", "web-server/server.js"]
