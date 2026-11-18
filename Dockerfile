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
    PUID=1000 \
    PGID=1000 \
    MARQUEE_PORT=9797 \
    MARQUEE_DATA_DIR=/config \
    MARQUEE_WEB_DIR=/app/web

# Bot-check solver: FlareSolverr (MIT), with its own Chrome. Marquee starts it
# only when "Solve bot checks" is on, listening on 127.0.0.1 only.
ARG FLARESOLVERR_VERSION=v3.5.2
ARG FLARESOLVERR_SHA256=84f6df48849b2e1742692841805c4f284118fe4e2798b49d3a78159e89a46a91
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xvfb xauth \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libdbus-1-3 libxkbcommon0 libxcomposite1 libxdamage1 \
      libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 libxshmfence1 libx11-xcb1 libxss1 libgtk-3-0 fonts-liberation \
 && curl -fsSL -o /tmp/fs.tar.gz "https://github.com/FlareSolverr/FlareSolverr/releases/download/${FLARESOLVERR_VERSION}/flaresolverr_linux_x64.tar.gz" \
 && echo "${FLARESOLVERR_SHA256}  /tmp/fs.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/fs.tar.gz -C /opt && rm /tmp/fs.tar.gz \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
ENV MARQUEE_SOLVER_BIN=/opt/flaresolverr/flaresolverr

WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /src/apps/server/dist ./dist
COPY --from=build /src/apps/web/dist ./web

COPY docker/entrypoint.sh /usr/local/bin/marquee-entrypoint
RUN chmod 755 /usr/local/bin/marquee-entrypoint && mkdir -p /config && command -v setpriv
VOLUME /config
EXPOSE 9797

# The entrypoint fixes /config ownership, then drops to PUID:PGID (never runs
# the app as root). On Unraid set PUID=99 and PGID=100.
ENTRYPOINT ["marquee-entrypoint"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MARQUEE_PORT||9797)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

LABEL org.opencontainers.image.title="Marquee" \
      org.opencontainers.image.description="Self-hosted movies and TV: requests, downloads and stats in one app" \
      org.opencontainers.image.source="https://github.com/The-Croz/marquee" \
      org.opencontainers.image.licenses="GPL-3.0-or-later" \
      org.opencontainers.image.version=$VERSION

CMD ["node", "dist/index.js"]
