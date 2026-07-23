# Multi-arch (amd64 + arm64) image on the official Playwright base so the
# Migros Cloudflare bypass and Lidl rendering work out of the box.
# The tag MUST match the playwright-core version in package.json — the
# browsers baked into the image are revision-locked to that version.
FROM mcr.microsoft.com/playwright:v1.61.1-noble AS build

# better-sqlite3 needs native compilation tools (python3, make, g++)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY pwa ./pwa
RUN npm run build && npm run build:pwa \
  && npm prune --omit=dev

# Smoke-check: verify better-sqlite3 native binding loads
RUN node -e "require('better-sqlite3')"

FROM mcr.microsoft.com/playwright:v1.61.1-noble

ENV NODE_ENV=production \
    PORT=3000 \
    SWISS_SHOPPING_CACHE_DIR=/data/cache \
    SWISS_SHOPPING_DB_PATH=/data/cache/catalog.sqlite3

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# The web server serves the manual testing UI from src/web/public at runtime.
COPY src/web/public ./src/web/public

# Adapters only ever launch chromium (see src/adapters/live/*Browser.ts) — drop the
# unused firefox/webkit engines bundled by the base image to save significant space
# on disk-constrained deploy targets.
RUN rm -rf /ms-playwright/firefox-* /ms-playwright/webkit-*

RUN mkdir -p /data/cache && chown -R pwuser:pwuser /data /app
USER pwuser

VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/source-status').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/web/server.js"]
