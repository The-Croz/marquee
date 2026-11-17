# ---------- build ----------
FROM node:22-bookworm-slim AS build
# Toolchain for better-sqlite3's native module
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /src

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
# A self-contained copy of the server with production dependencies only
RUN pnpm --filter @marquee/server deploy --prod --legacy /out

# ---------- runtime ----------
FROM node:22-bookworm-slim
ARG VERSION=dev
ENV NODE_ENV=production \
    MARQUEE_VERSION=$VERSION \
    MARQUEE_PORT=9797 \
    MARQUEE_DATA_DIR=/config \
    MARQUEE_WEB_DIR=/app/web

WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /src/apps/server/dist ./dist
COPY --from=build /src/apps/web/dist ./web

RUN mkdir -p /config && chown node:node /config
VOLUME /config
EXPOSE 9797

# Runs as the unprivileged "node" user (1000:1000) by default.
# On Unraid, pass --user 99:100 so files match the nobody:users convention.
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MARQUEE_PORT||9797)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

LABEL org.opencontainers.image.title="Marquee" \
      org.opencontainers.image.description="Self-hosted movies and TV: requests, downloads and stats in one app" \
      org.opencontainers.image.source="https://github.com/The-Croz/marquee" \
      org.opencontainers.image.licenses="GPL-3.0-or-later" \
      org.opencontainers.image.version=$VERSION

CMD ["node", "dist/index.js"]
