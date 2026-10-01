#!/usr/bin/env bash
# Production-image rehearsal (Phase 6, G10): builds the web, api, worker and migrate images, runs
# them as they would run on AWS (read-only root file system, non-root, production environment)
# against the LOCAL services of docker-compose.yml, checks them, and removes everything it made.
#
#   docker compose up -d              # postgres, redis, minio, mailpit (once)
#   scripts/smoke-prod.sh             # build (layer cache), rehearse, tear down
#   scripts/smoke-prod.sh --clean     # the same from a clean build (--no-cache)
#   scripts/smoke-prod.sh --no-build  # reuse the images built before
#   scripts/smoke-prod.sh --keep      # leave the rehearsal running afterwards (stop it with --down RUN_ID)
#
# Isolation: the rehearsal has its OWN database (loons_rehearsal_<id>), bucket (loons-rehearsal-<id>)
# and Redis key prefix (rehearsal-<id>:); it never touches loons_helpdesk or any other data. The
# secrets are random per run and exist only in this process's environment. Host ports 3100 / 4100
# (loopback), so a development stack on 3000 / 4000 can keep running.
#
# What it proves: the images build, the migrate image brings an EMPTY database to the current schema
# (and is a no-op the second time), the production seed adds configuration and no demo data, the
# containers become healthy, /health and /health/live answer, the web login page is served with the
# security headers and without the development staff password form, a Socket.IO connection without a
# token is refused, the Swagger UI / OpenAPI document are not served, an AWS runtime marker makes each
# service refuse the rehearsal profile, nothing runs as root, the root file system is read-only, and the
# logs hold no secrets. It does not sign in (the staff password form does not exist in production).
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
export MSYS_NO_PATHCONV=1 # Git Bash on Windows: do not rewrite /paths given to docker

CLEAN=0
BUILD=1
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --clean) CLEAN=1 ;;
    --no-build) BUILD=0 ;;
    --keep) KEEP=1 ;;
    -h | --help)
      sed -n '2,23p' "$0"
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      exit 2
      ;;
  esac
  shift
done

# The Docker CLI is not on PATH in every Git Bash on Windows.
if ! command -v docker > /dev/null 2>&1; then
  for dir in "/c/Users/$USERNAME/AppData/Local/Programs/DockerDesktop/resources/bin" "/c/Program Files/Docker/Docker/resources/bin"; do
    [ -d "$dir" ] && PATH="$PATH:$dir"
  done
fi
command -v docker > /dev/null 2>&1 || {
  echo "docker not found" >&2
  exit 2
}

# ─────────────────────────── identity of this run ───────────────────────────
RUN_ID="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
export REHEARSAL_DB="loons_rehearsal_${RUN_ID}"
export REHEARSAL_BUCKET="loons-rehearsal-${RUN_ID}"
export REHEARSAL_PREFIX="rehearsal-${RUN_ID}"
export REHEARSAL_WEB_PORT="${REHEARSAL_WEB_PORT:-3100}"
export REHEARSAL_API_PORT="${REHEARSAL_API_PORT:-4100}"
export REHEARSAL_ADMIN_EMAIL="rehearsal.admin@loonsgroup.com"
export REHEARSAL_VERSION="rehearsal-${RUN_ID}"
secret() { head -c 48 /dev/urandom | base64 | tr -d '=+/\n' | cut -c1-48; }
export AUTH_SECRET API_JWT_SECRET INTERNAL_API_KEY
AUTH_SECRET="$(secret)"
API_JWT_SECRET="$(secret)"
INTERNAL_API_KEY="$(secret)"

# Names this script is allowed to remove: it can only ever delete what it created.
[[ "$REHEARSAL_DB" =~ ^loons_rehearsal_[0-9a-f]{8}$ ]] || exit 3
[[ "$REHEARSAL_BUCKET" =~ ^loons-rehearsal-[0-9a-f]{8}$ ]] || exit 3
[[ "$REHEARSAL_PREFIX" =~ ^rehearsal-[0-9a-f]{8}$ ]] || exit 3

DANGLING_VOLUMES_BEFORE="$(docker volume ls -q -f dangling=true | wc -l | tr -d ' ')"
COMPOSE=(docker compose -f docker-compose.prod.yml)
WEB="http://127.0.0.1:${REHEARSAL_WEB_PORT}"
API="http://127.0.0.1:${REHEARSAL_API_PORT}"
LOG_DIR="${TMPDIR:-/tmp}/loons-smoke-${RUN_ID}"
mkdir -p "$LOG_DIR"
# Native Windows programs (curl.exe) need a Windows path; Git Bash tools accept it too.
LOG_DIR="$(cygpath -m "$LOG_DIR" 2> /dev/null || echo "$LOG_DIR")"

PASSED=0
FAILED=0
FAILURES=()
START=$SECONDS
PHASE_START=$SECONDS
TIMINGS=()

say() { printf '\n== %s\n' "$*"; }
phase_done() {
  TIMINGS+=("$1: $((SECONDS - PHASE_START)) s")
  PHASE_START=$SECONDS
}
pass() {
  PASSED=$((PASSED + 1))
  printf '  ok    %s\n' "$1"
}
fail() {
  FAILED=$((FAILED + 1))
  FAILURES+=("$1")
  printf '  FAIL  %s\n' "$1"
}
# check "description" command...   (the command's exit status decides)
check() {
  local what="$1"
  shift
  if "$@" > "$LOG_DIR/last-check.log" 2>&1; then pass "$what"; else
    fail "$what"
    sed 's/^/        /' "$LOG_DIR/last-check.log" | head -15
  fi
}

# ─────────────────────────── the local services ───────────────────────────
service() {
  docker ps --filter "label=com.docker.compose.project=loons-helpdesk" \
    --filter "label=com.docker.compose.service=$1" --filter status=running -q | head -1
}
PG="$(service postgres)"
REDIS="$(service redis)"
MINIO="$(service minio)"
if [ -z "$PG" ] || [ -z "$REDIS" ] || [ -z "$MINIO" ]; then
  echo "postgres, redis and minio of docker-compose.yml must be running: docker compose up -d" >&2
  exit 2
fi
for port in "$REHEARSAL_WEB_PORT" "$REHEARSAL_API_PORT"; do
  if (echo > "/dev/tcp/127.0.0.1/$port") 2> /dev/null; then
    echo "port $port is in use; set REHEARSAL_WEB_PORT / REHEARSAL_API_PORT" >&2
    exit 2
  fi
done
MC_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$(docker ps -aq --filter label=com.docker.compose.service=minio-init --filter label=com.docker.compose.project=loons-helpdesk | head -1)" 2> /dev/null || true)"
MC_IMAGE="${MC_IMAGE:-quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z}"
NETWORK=loons-helpdesk_default

psql_admin() { docker exec -i "$PG" psql -U loons -d postgres -v ON_ERROR_STOP=1 -tA "$@"; }
psql_rehearsal() { docker exec -i "$PG" psql -U loons -d "$REHEARSAL_DB" -v ON_ERROR_STOP=1 -tA "$@"; }
redis_keys() { docker exec "$REDIS" redis-cli --scan --pattern "${REHEARSAL_PREFIX}:*"; }
mc_run() {
  docker run --rm --network "$NETWORK" --entrypoint sh "$MC_IMAGE" -c \
    "mc alias set local http://minio:9000 loons loons-local-secret > /dev/null && $1"
}

# ─────────────────────────── teardown (always) ───────────────────────────
TORN_DOWN=0
teardown() {
  [ "$TORN_DOWN" = 1 ] && return
  TORN_DOWN=1
  say "Teardown"
  "${COMPOSE[@]}" --profile seed down --volumes --remove-orphans --timeout 20 > "$LOG_DIR/down.log" 2>&1 || true
  psql_admin -c "DROP DATABASE IF EXISTS \"$REHEARSAL_DB\" WITH (FORCE)" > /dev/null 2>&1 || true
  redis_keys | while read -r key; do docker exec "$REDIS" redis-cli unlink "$key" > /dev/null; done
  mc_run "mc rb --force local/$REHEARSAL_BUCKET" > /dev/null 2>&1 || true
  local left_db left_keys left_bucket
  left_db="$(psql_admin -c "SELECT count(*) FROM pg_database WHERE datname = '$REHEARSAL_DB'" 2> /dev/null || echo '?')"
  left_keys="$(redis_keys | wc -l | tr -d ' ')"
  left_bucket="$(mc_run "mc ls local | grep -c ' $REHEARSAL_BUCKET/' || true" 2> /dev/null | tr -d '[:space:]')"
  left_containers="$(docker ps -aq --filter label=com.docker.compose.project=loons-rehearsal | wc -l | tr -d ' ')"
  left_networks="$(docker network ls -q --filter label=com.docker.compose.project=loons-rehearsal | wc -l | tr -d ' ')"
  left_volumes="$(docker volume ls -q --filter label=com.docker.compose.project=loons-rehearsal | wc -l | tr -d ' ')"
  left_anonymous="$(( $(docker volume ls -q -f dangling=true | wc -l | tr -d ' ') - DANGLING_VOLUMES_BEFORE ))"
  if [ "$left_db" = 0 ] && [ "$left_keys" = 0 ] && [ "${left_bucket:-0}" = 0 ] && [ "$left_containers" = 0 ] \
    && [ "$left_networks" = 0 ] && [ "$left_volumes" = 0 ] && [ "$left_anonymous" -le 0 ]; then
    pass "teardown left nothing behind (database, Redis keys, bucket, containers, networks, volumes)"
  else
    fail "teardown left something: databases=$left_db redis-keys=$left_keys bucket=${left_bucket:-0} containers=$left_containers networks=$left_networks volumes=$left_volumes anonymous-volumes=$left_anonymous"
  fi
  rm -rf "$LOG_DIR/last-check.log"
}
on_exit() {
  local code=$?
  if [ "$KEEP" = 1 ] && [ "$code" = 0 ] && [ "$FAILED" = 0 ]; then
    echo
    echo "Rehearsal left running (--keep): web $WEB  api $API  database $REHEARSAL_DB  bucket $REHEARSAL_BUCKET  prefix ${REHEARSAL_PREFIX}:"
    echo "Remove it with: docker compose -f docker-compose.prod.yml down -v, then drop the database/bucket/keys named above."
    return
  fi
  teardown
  summary "$code"
}
summary() {
  local code=$1
  say "Summary (run ${RUN_ID}, ${REHEARSAL_DB})"
  printf '  checks passed: %s, failed: %s, total time: %s s\n' "$PASSED" "$FAILED" "$((SECONDS - START))"
  for t in "${TIMINGS[@]}"; do printf '  %s\n' "$t"; done
  if [ "$FAILED" != 0 ] || [ "$code" != 0 ]; then
    for f in "${FAILURES[@]}"; do printf '  FAILED: %s\n' "$f"; done
    printf '  logs: %s\n' "$LOG_DIR"
    exit 1
  fi
  rm -rf "$LOG_DIR"
  echo "  SMOKE TEST PASSED"
}
trap on_exit EXIT

# ─────────────────────────── 1. isolated resources ───────────────────────────
say "Isolated resources (database $REHEARSAL_DB, bucket $REHEARSAL_BUCKET, Redis prefix ${REHEARSAL_PREFIX}:)"
[ "$(psql_admin -c "SELECT count(*) FROM pg_database WHERE datname = '$REHEARSAL_DB'")" = 0 ]
[ -z "$(redis_keys)" ]
psql_admin -c "CREATE DATABASE \"$REHEARSAL_DB\"" > /dev/null
mc_run "mc mb local/$REHEARSAL_BUCKET > /dev/null && mc anonymous set none local/$REHEARSAL_BUCKET > /dev/null && printf '%s' '{\"Rules\":[{\"ID\":\"expire-browser-uploads\",\"Status\":\"Enabled\",\"Filter\":{\"Prefix\":\"attachments/\"},\"Expiration\":{\"Days\":1},\"NoncurrentVersionExpiration\":{\"NoncurrentDays\":1}}]}' | mc ilm import local/$REHEARSAL_BUCKET" > /dev/null
pass "created the empty database, the private bucket with the lifecycle rule and a free key prefix"
phase_done "isolated resources"

# ─────────────────────────── 2. images ───────────────────────────
if [ "$BUILD" = 1 ]; then
  say "Build the images ($([ "$CLEAN" = 1 ] && echo 'clean, --no-cache' || echo 'with layer cache'))"
  BUILD_ARGS=(build --progress=plain)
  [ "$CLEAN" = 1 ] && BUILD_ARGS+=(--no-cache)
  if "${COMPOSE[@]}" "${BUILD_ARGS[@]}" > "$LOG_DIR/build.log" 2>&1; then
    pass "built web, api, worker and migrate"
  else
    fail "image build failed (see $LOG_DIR/build.log)"
    tail -40 "$LOG_DIR/build.log"
    exit 1
  fi
  phase_done "build"
fi
# The worker image is built by compose through its service; all four tags must exist.
for image in loons-web loons-api loons-worker loons-migrate; do
  docker image inspect "$image:rehearsal" > /dev/null 2>&1 || {
    fail "image $image:rehearsal is missing"
    exit 1
  }
done
docker images --format '  {{.Repository}}:{{.Tag}}  {{.Size}} (disk)' | grep ':rehearsal' || true

# ─────────────────────────── 3. migrate an EMPTY database ───────────────────────────
say "Migrate image on the empty database"
EXPECTED_MIGRATIONS="$(find packages/db/prisma/migrations -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
"${COMPOSE[@]}" run --rm --no-deps migrate > "$LOG_DIR/migrate-1.log" 2>&1 && pass "prisma migrate deploy exits 0" || {
  fail "prisma migrate deploy failed"
  tail -30 "$LOG_DIR/migrate-1.log"
}
check "all $EXPECTED_MIGRATIONS migrations applied" \
  grep -q "All migrations have been successfully applied" "$LOG_DIR/migrate-1.log"
check "applied migrations recorded: $EXPECTED_MIGRATIONS" \
  test "$(psql_rehearsal -c 'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL')" = "$EXPECTED_MIGRATIONS"
"${COMPOSE[@]}" run --rm --no-deps migrate > "$LOG_DIR/migrate-2.log" 2>&1 || fail "second migrate run failed"
check "second run is a no-op (idempotent)" grep -q "No pending migrations to apply" "$LOG_DIR/migrate-2.log"
"${COMPOSE[@]}" run --rm --no-deps migrate prisma migrate status > "$LOG_DIR/migrate-status.log" 2>&1 || true
check "prisma migrate status is clean" grep -q "Database schema is up to date" "$LOG_DIR/migrate-status.log"
phase_done "migrate"

# ─────────────────────────── 4. production seed ───────────────────────────
say "Production seed (NODE_ENV=production, SEED_DEMO_DATA=true on purpose: must add no demo data)"
"${COMPOSE[@]}" --profile seed run --rm --no-deps seed > "$LOG_DIR/seed.log" 2>&1 && pass "seed exits 0" || {
  fail "seed failed"
  tail -30 "$LOG_DIR/seed.log"
}
check "configuration seeded (teams, categories, SLA policies, email templates)" \
  test "$(psql_rehearsal -c 'SELECT (SELECT count(*) FROM "Team") > 0 AND (SELECT count(*) FROM "Category") > 0 AND (SELECT count(*) FROM "SlaPolicy") > 0 AND (SELECT count(*) FROM "EmailTemplate") > 0')" = t
COUNTS="$(psql_rehearsal -c 'SELECT (SELECT count(*) FROM "Ticket")::text || (SELECT count(*) FROM "Organization")::text || (SELECT count(*) FROM "User")::text')"
check "no demo data: 0 tickets, 0 organisations, exactly the one admin user (got: $COUNTS)" test "$COUNTS" = 001
ADMIN="$(psql_rehearsal -c 'SELECT role::text || '"':'"' || ("passwordHash" IS NULL)::text FROM "User" LIMIT 1')"
check "the admin is a SUPER_ADMIN without a password (got: ${ADMIN:-nothing})" test "$ADMIN" = "SUPER_ADMIN:true"
phase_done "seed"

# ─────────────────────────── 5. start ───────────────────────────
say "Start api, worker and web"
"${COMPOSE[@]}" up -d --no-build > "$LOG_DIR/up.log" 2>&1 || {
  fail "docker compose up failed"
  cat "$LOG_DIR/up.log"
  exit 1
}
container() { "${COMPOSE[@]}" ps -q "$1"; }
wait_healthy() {
  local name="$1" id status deadline=$((SECONDS + 150))
  id="$(container "$name")"
  while [ $SECONDS -lt $deadline ]; do
    status="$(docker inspect -f '{{if .State.Running}}{{.State.Health.Status}}{{else}}exited{{end}}' "$id" 2> /dev/null || echo gone)"
    case "$status" in
      healthy) return 0 ;;
      exited | gone) return 1 ;;
    esac
    sleep 2
  done
  return 1
}
for svc in api worker web; do
  T0=$SECONDS
  if wait_healthy "$svc"; then
    pass "$svc container is healthy (HEALTHCHECK) after $((SECONDS - T0 + 0)) s of waiting"
  else
    fail "$svc did not become healthy"
    "${COMPOSE[@]}" logs --no-color --tail 40 "$svc" || true
  fi
done
phase_done "start and health"

# ─────────────────────────── 6. endpoint checks ───────────────────────────
say "API"
check "GET /health/live -> 200" test "$(curl -s -o /dev/null -w '%{http_code}' "$API/health/live")" = 200
HEALTH="$(curl -s -w '\n%{http_code}' "$API/health")"
check "GET /health -> 200 with db ok, redis ok and the release version" bash -c \
  "[ \"\$(printf '%s' '$HEALTH' | tail -1)\" = 200 ] && printf '%s' '$HEALTH' | head -1 | grep -q '\"status\":\"ok\"' && printf '%s' '$HEALTH' | head -1 | grep -q '\"db\":\"ok\"' && printf '%s' '$HEALTH' | head -1 | grep -q '\"redis\":\"ok\"' && printf '%s' '$HEALTH' | head -1 | grep -q '\"version\":\"$REHEARSAL_VERSION\"'"
check "/health leaks no secret or connection string" bash -c \
  "! printf '%s' '$HEALTH' | grep -E -i 'postgres|redis://|secret|password|$API_JWT_SECRET'"
check "an API call without a token is refused (401)" test "$(curl -s -o /dev/null -w '%{http_code}' "$API/me")" = 401
check "the Swagger UI and the OpenAPI document are not served in production (API_DOCS_ENABLED defaults to off)" bash -c \
  "[ \"\$(curl -s -o /dev/null -w '%{http_code}' '$API/docs')\" = 404 ] && [ \"\$(curl -s -o /dev/null -w '%{http_code}' '$API/docs/json')\" = 404 ]"

say "Socket.IO without a token"
SID="$(curl -s "$API/socket.io/?EIO=4&transport=polling" | sed -n 's/.*"sid":"\([^"]*\)".*/\1/p')"
check "the engine handshake is answered (a session id is issued)" test -n "$SID"
curl -s -X POST -H 'content-type: text/plain;charset=UTF-8' --data '40' "$API/socket.io/?EIO=4&transport=polling&sid=$SID" > /dev/null
POLL="$(curl -s "$API/socket.io/?EIO=4&transport=polling&sid=$SID" || true)"
check "the CONNECT without a token is answered with a CONNECT_ERROR, not a connection (got: ${POLL:0:60})" \
  bash -c "printf '%s' '$POLL' | grep -q '^44'"

say "Web"
curl -s -D "$LOG_DIR/login.headers" -o "$LOG_DIR/login.html" "$WEB/login" || true
check "GET /login -> 200" grep -q '^HTTP/[0-9.]* 200' "$LOG_DIR/login.headers"
for header in content-security-policy strict-transport-security x-frame-options x-content-type-options referrer-policy permissions-policy cross-origin-opener-policy; do
  check "response header $header present" grep -qi "^$header:" "$LOG_DIR/login.headers"
done
check "CSP connect-src allows exactly the API origin and the upload origin baked in at build" \
  grep -qi "^content-security-policy:.*connect-src 'self' http://localhost:${REHEARSAL_API_PORT} ws://localhost:${REHEARSAL_API_PORT} http://localhost:9000;" "$LOG_DIR/login.headers"
check "CSP has no unsafe-eval and forbids framing" bash -c \
  "! grep -qi \"^content-security-policy:.*unsafe-eval\" '$LOG_DIR/login.headers' && grep -qi \"^content-security-policy:.*frame-ancestors 'none'\" '$LOG_DIR/login.headers'"
check "no X-Powered-By header" bash -c "! grep -qi '^x-powered-by:' '$LOG_DIR/login.headers'"
check "the client login page has its password field (the control for the next check)" grep -q 'type="password"' "$LOG_DIR/login.html"
curl -s -o "$LOG_DIR/staff.html" -w '%{http_code}' "$WEB/staff/login" > "$LOG_DIR/staff.code"
check "GET /staff/login -> 200" test "$(cat "$LOG_DIR/staff.code")" = 200
check "no staff password form although AUTH_DEV_STAFF_LOGIN=true is set (production ignores it)" bash -c \
  "! grep -q 'type=\"password\"' '$LOG_DIR/staff.html'"
check "an unknown page is answered without a server error" test "$(curl -s -o /dev/null -w '%{http_code}' "$WEB/definitely-not-a-page")" -lt 500
phase_done "endpoint checks"

# ─────────────────────────── 6b. an AWS runtime refuses the rehearsal profile ───────────────────────────
say "An AWS runtime marker (ECS_CONTAINER_METADATA_URI_V4) with DEPLOY_PROFILE=rehearsal must stop each service"
for svc in api worker web; do
  "${COMPOSE[@]}" run --rm --no-deps -e ECS_CONTAINER_METADATA_URI_V4=http://169.254.170.2/v4/rehearsal "$svc" \
    > "$LOG_DIR/aws-marker-$svc.log" 2>&1 && code=0 || code=$?
  check "$svc refuses to start on an AWS runtime with DEPLOY_PROFILE=rehearsal (exit $code, 1 expected)" bash -c \
    "[ $code = 1 ] && grep -q 'an AWS runtime was detected' '$LOG_DIR/aws-marker-$svc.log'"
done
phase_done "aws runtime guard"

# ─────────────────────────── 7. container hardening ───────────────────────────
say "Container hardening"
for svc in api worker web; do
  id="$(container "$svc")"
  check "$svc runs as a non-root user" test "$(docker exec "$id" id -u)" != 0
  check "$svc root file system is read-only (HostConfig)" test "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$id")" = true
  check "$svc cannot write outside /tmp" bash -c "! docker exec '$id' sh -c 'touch /app/should-not-exist 2>/dev/null'"
  check "$svc can write /tmp" docker exec "$id" sh -c 'touch /tmp/ok && rm /tmp/ok'
  check "$svc PID 1 is tini (signals, zombie reaping)" bash -c "docker exec '$id' cat /proc/1/cmdline | tr '\\0' ' ' | grep -q tini"
done
check "worker health check script agrees (exit 0)" docker exec "$(container worker)" node src/healthcheck-worker.ts

say "Logs"
for svc in api worker web; do
  "${COMPOSE[@]}" logs --no-color "$svc" > "$LOG_DIR/$svc.log" 2>&1 || true
done
check "the worker logged 'worker ready'" grep -q 'worker ready' "$LOG_DIR/worker.log"
check "the rehearsal profile warning is logged by api, worker and web" bash -c \
  "grep -q 'DEPLOY_PROFILE=rehearsal' '$LOG_DIR/api.log' && grep -q 'DEPLOY_PROFILE=rehearsal' '$LOG_DIR/worker.log' && grep -q 'DEPLOY_PROFILE=rehearsal' '$LOG_DIR/web.log'"
check "no error or fatal log lines in api, worker, web (the web's rehearsal warning is a [config] line, not an error)" bash -c \
  "! grep -E '\"level\":(50|60)|ERR_|Error:' '$LOG_DIR/api.log' '$LOG_DIR/worker.log' '$LOG_DIR/web.log' && ! grep -E '\\[config\\]' '$LOG_DIR/api.log' '$LOG_DIR/worker.log' '$LOG_DIR/web.log' | grep -v 'DEPLOY_PROFILE=rehearsal'"
check "no secret appears in any log (JWT secret, internal key, auth secret, database password)" bash -c \
  "! grep -F -e '$API_JWT_SECRET' -e '$INTERNAL_API_KEY' -e '$AUTH_SECRET' -e 'loons-local-secret' -e 'loons:loons@' '$LOG_DIR'/api.log '$LOG_DIR'/worker.log '$LOG_DIR'/web.log"
phase_done "hardening and logs"

# ─────────────────────────── 7b. resource use ───────────────────────────
say "Memory of the running containers (informational, idle after start-up)"
docker stats --no-stream --format '  {{.Name}}  memory {{.MemUsage}}  cpu {{.CPUPerc}}  pids {{.PIDs}}' \
  "$(container api)" "$(container worker)" "$(container web)" || true

# ─────────────────────────── 7c. what is inside the images ───────────────────────────
say "Image contents (no .env, tests, design files, keys or Prisma CLI where it does not belong)"
# Runs inside each image; prints "<KIND> <path>" per finding. node_modules is searched separately:
# third-party packages ship their own tests, which is not this project's test code.
IMAGE_SCAN='
find / -xdev -type f \( -name ".env" -o -name ".env.*" -o -name ".npmrc" -o -name ".netrc" \) 2>/dev/null | sed "s/^/DOTENV /"
find / -xdev -not -path "*/node_modules/*" -not -path "/usr/*" -not -path "/proc/*" -not -path "/sys/*" -type f \( -name "*.test.*" -o -name "*.spec.*" \) 2>/dev/null | sed "s/^/TESTFILE /"
find / -xdev -not -path "*/node_modules/*" -not -path "/usr/*" -not -path "/proc/*" -type d \( -name design -o -name docs -o -name e2e -o -name .git -o -name test-results -o -name playwright-report \) 2>/dev/null | sed "s/^/DEVDIR /"
find / -xdev -not -path "/etc/ssl/*" -not -path "/usr/*" -not -path "*/node_modules/*" -not -path "/app/certs/*" -type f \( -name "*.pem" -o -name "*.key" -o -name "*.p12" -o -name "id_rsa*" -o -name "*.pfx" \) 2>/dev/null | sed "s/^/KEYFILE /"
find /app -type f -perm -o+w 2>/dev/null | sed "s/^/WORLDWRITABLE /"
find /app -name "node_modules" -prune -o -name "*.map" -print 2>/dev/null | sed "s/^/SOURCEMAP /"
ls /app/node_modules/.pnpm /app/node_modules 2>/dev/null | grep -E "^(prisma|typescript|@prisma\+studio-core|eslint|vitest|@playwright)(@|$)" | sed "s/^/DEVTOOL /"
find /app -path "*/node_modules/*" \( -name "*.test.*" -o -name "*.spec.*" \) 2>/dev/null | wc -l | sed "s/^/THIRDPARTYTESTS /"
'
scan_image() { # image
  printf '%s' "$IMAGE_SCAN" | docker run --rm -i --entrypoint sh "$1" -s 2> /dev/null || true
}
for image in web api worker migrate; do
  scan="$(scan_image "loons-$image:rehearsal")"
  for kind in DOTENV TESTFILE DEVDIR KEYFILE WORLDWRITABLE SOURCEMAP; do
    found="$( (printf '%s\n' "$scan" | grep "^$kind " | head -5) || true)"
    check "image $image: no $kind findings" test -z "$found"
    if [ -n "$found" ]; then printf '        %s\n' "$found"; fi
  done
  tools="$( (printf '%s\n' "$scan" | grep '^DEVTOOL ' | sed 's/^DEVTOOL //' | cut -d@ -f1-2 | sort -u | tr '\n' ' ') || true)"
  if [ "$image" = migrate ]; then
    check "image migrate: the Prisma CLI is present (it is the point of this image) [tools: ${tools:-none}]" bash -c "[[ '$tools' == *prisma* ]]"
  else
    check "image $image: no Prisma CLI, TypeScript, ESLint, Vitest or Playwright [tools: ${tools:-none}]" test -z "$tools"
  fi
  printf '        third-party test files inside node_modules (not this project): %s\n' "$(printf '%s\n' "$scan" | sed -n 's/^THIRDPARTYTESTS //p')"
  # Layers and image metadata: no secret-looking build arguments or environment values.
  docker history --no-trunc --format '{{.CreatedBy}}' "loons-$image:rehearsal" > "$LOG_DIR/history-$image.txt"
  check "image $image: no secret, password, token or key in its build history" bash -c \
    "! grep -E -i '(secret|password|token|private)[_a-z]*=|AKIA[0-9A-Z]{12}' '$LOG_DIR/history-$image.txt'"
  check "image $image: its environment holds no secret ($(docker inspect -f '{{len .Config.Env}}' "loons-$image:rehearsal") variables)" bash -c \
    "! docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' 'loons-$image:rehearsal' | grep -E -i 'secret|password|token|api_key|database_url'"
  check "image $image runs as a non-root user by default" bash -c \
    "[ \"\$(docker inspect -f '{{.Config.User}}' 'loons-$image:rehearsal')\" = node ]"
done
phase_done "resource use and image contents"

# ─────────────────────────── 8. stop ───────────────────────────
say "Graceful stop"
for svc in worker api web; do
  id="$(container "$svc")"
  T0=$SECONDS
  docker stop --time 30 "$id" > /dev/null
  code="$(docker inspect -f '{{.State.ExitCode}}' "$id")"
  check "$svc stopped on SIGTERM in $((SECONDS - T0)) s with exit code $code (0 expected)" test "$code" = 0
done
phase_done "stop"
