# syntax=docker/dockerfile:1
#
# Web image (Phase 6, decisions G1 / G2): the Next.js standalone server.
#
#   docker build -f apps/web/Dockerfile -t loons-web \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.help.example.com \
#     --build-arg NEXT_PUBLIC_UPLOAD_ORIGIN=https://<bucket>.s3.<region>.amazonaws.com .
#
# The build context is the REPOSITORY ROOT (the allow-list in /.dockerignore keeps .env files,
# design/, docs/ and tests out of it).
#
# Build arguments - the ONLY values baked into the image. Both are public by nature (the browser
# calls them) and both end up in the page's Content-Security-Policy `connect-src` and in the
# client bundle, so a change means rebuilding the web image:
#   NEXT_PUBLIC_API_URL        https address of the API as the browser reaches it (REST + Socket.IO)
#   NEXT_PUBLIC_UPLOAD_ORIGIN  origin the browser uploads attachments to (https://<bucket>.s3.<region>.amazonaws.com)
# Every secret and every other setting (AUTH_SECRET, API_INTERNAL_URL, INTERNAL_API_KEY, ...) is
# read from the environment when the container starts: see .env.production.example.
#
# Both must be https addresses of real hosts: docker-check-build-args.ts fails the build otherwise.
# Only the local rehearsal image (docker-compose.prod.yml) passes --build-arg REHEARSAL_BUILD=true,
# which allows plain http and localhost. Never set it for an image that goes to AWS.
#
# Network access of the BUILD (the running container makes none of these requests): the base image
# from Docker Hub (or your ECR mirror of it), registry.npmjs.org (pnpm and the packages),
# fonts.googleapis.com / fonts.gstatic.com (`next build` fetches the IBM Plex Sans Arabic font from
# Google Fonts, next/font/google in app/fonts.ts, and self-hosts it in the output).
# Go-live hardening: pin the base image by digest (FROM node:<version>-bookworm-slim@sha256:<digest>).

ARG NODE_VERSION=24.21.0

# ───────────────────────────── build ─────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    npm_config_update_notifier=false \
    NEXT_TELEMETRY_DISABLED=1
# pnpm is installed with npm, at the version the root package.json pins in "packageManager".
COPY package.json /tmp/root-package.json
RUN version="$(node -p "require('/tmp/root-package.json').packageManager.replace(/^pnpm@/, '')")" \
    && npm install --global --no-fund --no-audit "pnpm@${version}" \
    && pnpm --version
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web apps/web
COPY packages/shared packages/shared
COPY packages/ui packages/ui
COPY packages/eslint-config packages/eslint-config
# Manifests of the workspace packages the web app does not use: a frozen lockfile covers them all.
COPY apps/api/package.json apps/api/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/emails/package.json packages/emails/package.json
RUN pnpm install --frozen-lockfile --filter "@loons/web..."

# Baked into the client bundle and the CSP header (apps/web/next.config.ts, security-headers.ts).
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_UPLOAD_ORIGIN
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_UPLOAD_ORIGIN=${NEXT_PUBLIC_UPLOAD_ORIGIN} \
    NODE_ENV=production
# Fails the build with an unusable address (missing, plain http, localhost) instead of shipping a
# page that cannot reach the API. REHEARSAL_BUILD=true (the local rehearsal image only) lifts the
# https / localhost rule.
ARG REHEARSAL_BUILD=false
RUN cd apps/web && node docker-check-build-args.ts
# `next build` directly (the package script wraps it in dotenv-cli for the repo-root .env, which a
# build context never contains).
RUN cd apps/web && pnpm exec next build \
    && test -f .next/standalone/apps/web/server.js
# Source maps are not needed at run time (the browser bundle has none): keep them out of the image.
RUN find apps/web/.next/standalone apps/web/.next/static -name '*.map' -delete

# ───────────────────────────── runtime ─────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS web
# tini: PID 1 that forwards SIGTERM and reaps zombies. npm, npx and corepack are removed: nothing
# in a running container installs packages.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-*
# NEXT_MANUAL_SIG_HANDLE: Next.js's own SIGTERM handler exits at once (code 143), dropping the
# requests in flight; docker-start.ts handles the signal instead (drain, then exit 0).
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_MANUAL_SIG_HANDLE=true \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# The standalone output holds server.js and the traced node_modules; static assets and public/ are
# not part of it and are copied next to it, as the Next.js docs describe.
COPY --from=build --chown=root:root /repo/apps/web/.next/standalone ./
COPY --from=build --chown=root:root /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=root:root /repo/apps/web/public ./apps/web/public
# Entry point: starts server.js and gives it a graceful stop (it has no SIGTERM handler of its own).
COPY --from=build --chown=root:root /repo/apps/web/docker-start.ts ./docker-start.ts
USER node
EXPOSE 3000
# The server prints "Ready" BEFORE its configuration check has finished (a bad configuration then
# exits the process), so the check requests a real page: the sign-in page, which needs neither the
# API nor a session. The root file system can be read-only: the app uses no next/image, the one
# feature that would write to .next/cache (/_next/image), and nothing else writes at run time.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login',{signal:AbortSignal.timeout(4000),redirect:'manual'}).then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "docker-start.ts"]
