# Forge Audio — web version (server + interface)
FROM node:22-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
# Optional deps needed here: rollup/esbuild native binaries (ffmpeg-static is pruned below)
RUN npm ci
COPY server server
COPY web web
RUN npm run build && npm prune --omit=dev --omit=optional

FROM node:22-trixie-slim
# Standalone yt-dlp build: bundles curl_cffi (impersonation, required by Dailymotion).
# Owned by node so `docker exec forge-audio yt-dlp -U` can update it without a rebuild.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
  && ARCH=$(dpkg --print-architecture) \
  && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux$([ "$ARCH" = arm64 ] && echo _aarch64)" -o /usr/local/bin/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp && chown node:node /usr/local/bin/yt-dlp \
  && apt-get purge -y curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server server
COPY --from=build /app/web/dist web/dist
COPY --from=build /app/package.json .
# Accounts, sessions and each user's library (playlists, history…). Mounted as a volume: survives rebuilds.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 FFMPEG_PATH=/usr/bin/ffmpeg DATA_DIR=/app/data
EXPOSE 8787
# Le runtime lance `node` seul : npm/corepack retires avec les CVE qu'ils embarquent
# (brace-expansion, sigstore, pacote, picomatch... scan Trivy 2026-10-01).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
USER node
CMD ["node", "server/src/index.js"]
