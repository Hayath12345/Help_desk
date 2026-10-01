# syntax=docker/dockerfile:1
#
# API, worker and migrate images (Phase 6, decisions G1 / G3 / G5). One file, three targets that
# share the build:
#
#   docker build -f apps/api/Dockerfile --target api     -t loons-api     .
#   docker build -f apps/api/Dockerfile --target worker  -t loons-worker  .
#   docker build -f apps/api/Dockerfile --target migrate -t loons-migrate .
#
# The build context is the REPOSITORY ROOT (the allow-list in /.dockerignore keeps .env files,
# design/, docs/ and tests out of it). Nothing secret is a build argument; configuration reaches
# the containers through their environment (.env.production.example).
#
#   api      node --import tsx src/server.ts      HTTP + Socket.IO on :4000, health check /health/live
#   worker   node --import tsx src/worker.ts      BullMQ consumers + schedulers, heartbeat-file health check
#   migrate  prisma migrate deploy                one-off task: apply migrations (also: production seed)
#
# Network access of the BUILD (none of it is needed when a container runs, except as noted): the base
# image from Docker Hub (or your ECR mirror of it), deb.debian.org (apt: openssl, tini),
# registry.npmjs.org (pnpm and the packages) and binaries.prisma.sh (the Prisma schema engine, fetched
# by the migrate tree's install). The migrate TASK itself makes no request to Prisma: the engine is
# already in the image and CHECKPOINT_DISABLE=1 (below) turns off the CLI's version check
# (checkpoint.prisma.io). Go-live hardening: pin the base image by digest
# (FROM node:<version>-bookworm-slim@sha256:<digest>) so a rebuild cannot pick up a changed tag.
#
# The API runs through tsx, as it does in development: the code base has no compile step (the
# workspace packages export TypeScript sources). Only production dependencies are installed
# (`pnpm deploy --prod`), the Prisma CLI is only in the `migrate` image, and the root file system
# can be read-only: the only writable path needed is /tmp (tsx's transform cache, the worker heartbeat).

ARG NODE_VERSION=24.21.0

# ───────────────────────────── base: Node + pnpm ─────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    npm_config_update_notifier=false
# pnpm is installed with npm, at the version the root package.json pins in "packageManager" (corepack
# is not used: `corepack enable` fails on the Windows hosts this repository is developed on).
COPY package.json /tmp/root-package.json
RUN version="$(node -p "require('/tmp/root-package.json').packageManager.replace(/^pnpm@/, '')")" \
    && npm install --global --no-fund --no-audit "pnpm@${version}" \
    && pnpm --version
# OpenSSL must be present while Prisma installs: it picks the schema-engine binary that matches the
# libssl it finds (without it, a binary for OpenSSL 1.1 is fetched and fails on Debian 12).
RUN apt-get update \
    && apt-get install --yes --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo

# ───────────────────────────── build: full install + Prisma client ─────────────────────────────
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api apps/api
COPY packages packages
# The workspace manifests of apps/web and the other packages are needed for a frozen lockfile;
# only the API and what it depends on are installed. The postinstall of @loons/db runs
# `prisma generate` (packages/db/src/generated).
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter "@loons/api..."
# Production trees: the API / worker (no dev dependencies, no Prisma CLI) ...
RUN pnpm --filter @loons/api deploy --prod --ignore-scripts /out/api
# ... with the generated Prisma client copied in (the deploy copies package files, and the client
# is not one: it is generated), into the copy of @loons/db that the deployed tree resolves.
RUN db="$(readlink -f /out/api/node_modules/@loons/db)" \
    && cp -R packages/db/src/generated "$db/src/generated" \
    && test -f "$db/src/generated/prisma/client.ts"
# @prisma/client lists the Prisma CLI and TypeScript as optional peers and the lockfile resolves
# them, so even a "production" deploy contains the CLI (Prisma Studio, ...). prune-store.ts cuts
# those two links and deletes what nothing else reaches.
RUN node apps/api/scripts/prune-store.ts /out/api --drop-peers \
    && ! ls /out/api/node_modules/.pnpm | grep -E '^(prisma|typescript|@prisma\+studio)' \
    && test ! -e /out/api/node_modules/.bin/prisma
# ... and the migrate tree: @loons/db with its dev dependencies (the Prisma CLI, tsx for the
# seed). Scripts run here: Prisma's install step fetches its schema engine, and postinstall
# regenerates the client. (A deployed package sits at /out/migrate, so its tsconfig's
# "../../tsconfig.base.json" is /tsconfig.base.json while it is built.)
RUN cp tsconfig.base.json /tsconfig.base.json \
    && pnpm --filter @loons/db deploy /out/migrate
# Of the dev dependencies only the Prisma CLI and tsx (the seed) stay; eslint, vitest, TypeScript ...
# are dropped.
RUN node apps/api/scripts/prune-store.ts /out/migrate --keep-dev=prisma,tsx \
    && ls /out/migrate/node_modules/.pnpm/@prisma+engines@*/node_modules/@prisma/engines/ \
       | grep -q schema-engine-debian-openssl-3.0.x
# The deployed trees get their own copy of the base tsconfig (tsx reads tsconfig.json for the JSX
# setting of the e-mail templates; an "extends" pointing outside /app would not resolve), and lose
# the files that only matter in the repository.
RUN rm -rf /out/api/scripts /out/api/pnpm-lock.yaml /out/api/pnpm-workspace.yaml \
       /out/api/vitest.config.ts /out/api/eslint.config.js /out/api/Dockerfile \
    && rm -rf /out/migrate/pnpm-lock.yaml /out/migrate/pnpm-workspace.yaml \
       /out/migrate/vitest.config.ts /out/migrate/eslint.config.js \
    && for tree in api migrate; do \
         cp tsconfig.base.json "/out/$tree/tsconfig.base.json" \
         && sed -i 's#"../../tsconfig.base.json"#"./tsconfig.base.json"#' "/out/$tree/tsconfig.json" \
         && grep -q '"./tsconfig.base.json"' "/out/$tree/tsconfig.json"; \
       done

# ───────────────────────────── runtime base ─────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
# tini: PID 1 that forwards SIGTERM and reaps zombies (no `--init` needed on ECS / Kubernetes).
# npm, npx and corepack are removed: nothing in a running container installs packages.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-*
ENV NODE_ENV=production
WORKDIR /app
ENTRYPOINT ["/usr/bin/tini", "--"]
# The database CA files (RDS) are public; see deploy/certs/README.md. rds-global-bundle.pem is read
# by the API and worker (node-postgres reads every certificate in it); rds-ca.pem holds ONE
# certificate, the root of your instance's chain, for Prisma Migrate (which reads only the first
# certificate of its file). REQUIRE_RDS_CA=true makes the build fail when either is missing (use it
# for the production build).
ARG REQUIRE_RDS_CA=false
COPY deploy/certs /app/certs
RUN if [ "$REQUIRE_RDS_CA" = "true" ]; then \
      for f in rds-global-bundle.pem rds-ca.pem; do \
        if [ ! -s "/app/certs/$f" ]; then \
          echo "REQUIRE_RDS_CA=true but deploy/certs/$f is missing (see deploy/certs/README.md)" >&2; \
          exit 1; \
        fi; \
      done; \
    fi

# ───────────────────────────── api ─────────────────────────────
FROM runtime AS api
COPY --from=build --chown=root:root /out/api /app
USER node
ENV API_HOST=0.0.0.0 \
    API_PORT=4000
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health/live',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--import", "tsx", "src/server.ts"]

# ───────────────────────────── worker ─────────────────────────────
FROM runtime AS worker
COPY --from=build --chown=root:root /out/api /app
USER node
# The worker has no port: while healthy it refreshes this file, and the health check reads it
# (src/lib/worker-heartbeat.ts). /tmp is the one writable path.
ENV WORKER_HEARTBEAT_FILE=/tmp/loons-worker-heartbeat
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD ["node", "src/healthcheck-worker.ts"]
CMD ["node", "--import", "tsx", "src/worker.ts"]

# ───────────────────────────── migrate ─────────────────────────────
FROM runtime AS migrate
# The Prisma schema engine needs OpenSSL (libssl); ca-certificates is already in the base image.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=root:root /out/migrate /app
USER node
# Prisma's CLI phones home (checkpoint.prisma.io) to look for a newer version; a one-off task in a
# private subnet should make no such request.
ENV PATH=/app/node_modules/.bin:$PATH \
    CHECKPOINT_DISABLE=1
# One-off task: bring the database to the schema in prisma/migrations, then exit. Idempotent (an
# up-to-date database is a no-op). Never `migrate dev` / `migrate reset` here.
# The production seed (configuration only, NODE_ENV=production) is the same image with another
# command:   prisma db seed
CMD ["prisma", "migrate", "deploy"]
