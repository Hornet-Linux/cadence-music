# Build from the repository root:
#   docker build -f apps/server/Dockerfile -t cadence-server .

# ---- ffmpeg: one static binary (opus, mp3, aac), no extra system packages -----
# Used by the optional loudness, audio-analysis, transcode and library-health
# community plugins. To build without it, delete the COPY line further down:
# those plugins then report "ffmpeg missing" and everything else is unaffected.
FROM mwader/static-ffmpeg:7.1.1@sha256:11a44711684c0b9f754c047dcd64235b8b52deab251bd0e0a86f22faa160749c AS ffmpeg

# ---- Web player: the desktop UI built as a website (served at /app) --------
FROM node:22-slim AS web
# git is needed to install the castlabs Electron package (a GitHub dependency);
# --ignore-scripts skips downloading its binary, which a website doesn't need.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY packages/shared ./packages/shared
# The UI shares the LLM provider code with the server (dependency-free).
COPY apps/server/src/llm/core ./apps/server/src/llm/core
COPY apps/desktop/package.json ./apps/desktop/
WORKDIR /src/apps/desktop
RUN npm install --no-audit --no-fund --ignore-scripts
COPY apps/desktop ./
RUN npm run build:web

# ---- Server ----------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /src
# Shared API types (type-only; needed to compile, not at runtime).
COPY packages/shared ./packages/shared
COPY apps/server/package.json ./apps/server/
WORKDIR /src/apps/server
RUN npm install --no-audit --no-fund
COPY apps/server ./
RUN npm run build && npm prune --omit=dev && find dist -name '*.test.js' -delete

FROM node:22-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data \
    MUSIC_DIR=/music \
    WEB_DIR=/app/web
WORKDIR /app
COPY --from=build /src/apps/server/package.json ./
COPY --from=build /src/apps/server/node_modules ./node_modules
COPY --from=build /src/apps/server/dist ./dist
COPY --from=web /src/apps/desktop/dist-web ./web
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
# /data must be writable by the unprivileged user; named volumes inherit this.
RUN mkdir -p /data /music && chown node:node /data
USER node
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]
