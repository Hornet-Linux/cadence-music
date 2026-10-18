# Build from the repository root:
#   docker build -f apps/server/Dockerfile -t cadence-server .

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
    MUSIC_DIR=/music
WORKDIR /app
COPY --from=build /src/apps/server/package.json ./
COPY --from=build /src/apps/server/node_modules ./node_modules
COPY --from=build /src/apps/server/dist ./dist
# /data must be writable by the unprivileged user; named volumes inherit this.
RUN mkdir -p /data /music && chown node:node /data
USER node
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]
