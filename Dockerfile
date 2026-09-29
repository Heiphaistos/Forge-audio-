# Forge Audio — web version (server + interface)
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
# Optional deps needed here: rollup/esbuild native binaries (ffmpeg-static is pruned below)
RUN npm ci
COPY server server
COPY web web
RUN npm run build && npm prune --omit=dev --omit=optional

FROM node:22-bookworm-slim
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
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 FFMPEG_PATH=/usr/bin/ffmpeg
EXPOSE 8787
USER node
CMD ["node", "server/src/index.js"]
