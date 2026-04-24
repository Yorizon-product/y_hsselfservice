# syntax=docker/dockerfile:1.7
# Multi-stage Next.js image for self-hosted deployment on yorizoncasey.
#
# Stage 1: install deps (native build tools for better-sqlite3).
# Stage 2: build Next.js in standalone mode.
# Stage 3: slim runtime with the standalone output + static/public; non-root;
#          healthchecked via /api/health.
#
# Local build:     docker build -t hsselfservice:local .
# Production:      pushed by .github/workflows/publish.yml to
#                  ghcr.io/yorizon-product/y_hsselfservice:{main,sha-<short>}

ARG NODE_VERSION=22

# ─── Stage 1: deps ────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app

# better-sqlite3 is a native module — needs build tools. libstdc++ / zlib are
# already in the base image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=optional

# ─── Stage 2: builder ────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

# Build-time env stubs so `next build` doesn't bail on the session-secret
# guard in lib/session.ts. Real secrets are injected at runtime from .env.
ENV SESSION_SECRET=build-placeholder-secret-long-enough-32-chars-aaaa \
    HUBSPOT_CLIENT_ID=build-placeholder \
    HUBSPOT_CLIENT_SECRET=build-placeholder \
    HUBSPOT_REDIRECT_URI=https://build.placeholder/api/auth/callback

RUN npm run build

# ─── Stage 3: runtime ────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8081 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/data

# Non-root user. uid clears host's system users.
RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --home-dir /app --shell /usr/sbin/nologin app \
 && mkdir -p /app /data \
 && chown -R app:app /app /data

# Copy Next.js standalone output. Standalone bundler traces required
# node_modules (including native addons like better-sqlite3, provided
# next.config.js declares the .node file via outputFileTracingIncludes).
COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static
COPY --from=builder --chown=app:app /app/public ./public

USER app

VOLUME ["/data"]
EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8081/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" \
  || exit 1

CMD ["node", "server.js"]
