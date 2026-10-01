#!/usr/bin/env bash
# TLS rehearsal for the database and Redis connection strings (Phase 6, G6 / G7).
#
# The production configuration requires `sslmode=verify-full` (DATABASE_URL) and `rediss://`
# (REDIS_URL). Real RDS / ElastiCache cannot be used here, so this starts a throw-away PostgreSQL and
# a throw-away Redis with TLS and a private CA (generated with the OpenSSL of the migrate image), and
# checks with the production images that
#   - Prisma Migrate (the migrate image) and the API's driver (node-postgres, via @loons/db) accept
#     ONE documented URL and verify the server certificate,
#   - each of them REFUSES a missing CA and a host name that is not in the certificate,
#   - ioredis connects to a rediss:// server when the CA is trusted and refuses an unknown CA,
#   - how a multi-certificate bundle (like the RDS one) behaves with each of them.
# Everything it creates (two containers, one volume) is removed again; it touches no other data.
#
#   scripts/smoke-tls.sh [--keep]   (needs the images of scripts/smoke-prod.sh: loons-migrate:rehearsal, loons-api:rehearsal)
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export MSYS_NO_PATHCONV=1

if ! command -v docker > /dev/null 2>&1; then
  for dir in "/c/Users/$USERNAME/AppData/Local/Programs/DockerDesktop/resources/bin" "/c/Program Files/Docker/Docker/resources/bin"; do
    [ -d "$dir" ] && PATH="$PATH:$dir"
  done
fi
for image in loons-migrate:rehearsal loons-api:rehearsal; do
  docker image inspect "$image" > /dev/null 2>&1 || {
    echo "$image not found: run scripts/smoke-prod.sh first" >&2
    exit 2
  }
done

ID="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
NETWORK=loons-helpdesk_default
DANGLING_BEFORE="$(docker volume ls -q -f dangling=true | wc -l | tr -d ' ')"
VOLUME="loons-tls-$ID"
PG="loons-tls-pg-$ID"
RD="loons-tls-redis-$ID"
LOG="${TMPDIR:-/tmp}/loons-tls-$ID.log"
PASSED=0
FAILED=0
pass() {
  PASSED=$((PASSED + 1))
  printf '  ok    %s\n' "$1"
}
fail() {
  FAILED=$((FAILED + 1))
  printf '  FAIL  %s\n' "$1"
}
cleanup() {
  # -v: the postgres and redis images declare anonymous volumes, which `rm -f` alone leaves behind.
  docker rm -fv "$PG" "$RD" > /dev/null 2>&1 || true
  docker volume rm "$VOLUME" > /dev/null 2>&1 || true
  rm -f "$LOG"
  if [ -z "$(docker ps -aq --filter "name=loons-tls-.*-$ID")" ] && ! docker volume inspect "$VOLUME" > /dev/null 2>&1 \
    && [ "$(docker volume ls -q -f dangling=true | wc -l | tr -d ' ')" = "$DANGLING_BEFORE" ]; then
    pass "removed the containers and the volume"
  else
    fail "something was left behind (containers named loons-tls-*-$ID, volume $VOLUME)"
  fi
  printf '\n  checks passed: %s, failed: %s\n' "$PASSED" "$FAILED"
  if [ "$FAILED" = 0 ]; then echo "  TLS SMOKE TEST PASSED"; else exit 1; fi
}
if [ "${1:-}" = --keep ]; then trap 'echo "kept: $PG $RD $VOLUME"' EXIT; else trap cleanup EXIT; fi

echo "== Private CA and server certificates (host names postgres-tls and redis-tls)"
docker volume create "$VOLUME" > /dev/null
docker run --rm --user root -v "$VOLUME:/certs" --entrypoint sh loons-migrate:rehearsal -c '
set -e
cd /certs
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -subj "/CN=Loons rehearsal CA" -days 2 2> /dev/null
openssl req -x509 -newkey rsa:2048 -nodes -keyout other.key -out other.crt -subj "/CN=Another CA" -days 2 2> /dev/null
for name in postgres-tls redis-tls; do
  openssl req -newkey rsa:2048 -nodes -keyout "$name.key" -out "$name.csr" -subj "/CN=$name" 2> /dev/null
  printf "subjectAltName=DNS:%s\n" "$name" > "$name.ext"
  openssl x509 -req -in "$name.csr" -CA ca.crt -CAkey ca.key -CAcreateserial -out "$name.crt" -days 2 -extfile "$name.ext" 2> /dev/null
done
# Bundles like the RDS one hold many CA certificates: the right one first, or last.
cat ca.crt other.crt > bundle-right-first.pem
cat other.crt ca.crt > bundle-right-last.pem
chown 70:70 postgres-tls.key postgres-tls.crt && chmod 600 postgres-tls.key
chown 999:999 redis-tls.key redis-tls.crt && chmod 600 redis-tls.key
chmod 644 *.crt *.pem
' && pass "generated the CA, the server certificates and two CA bundles"

echo "== PostgreSQL 16 and Redis 7 with TLS"
docker run -d --name "$PG" --network "$NETWORK" --network-alias postgres-tls -v "$VOLUME:/certs:ro" \
  -e POSTGRES_USER=loons -e POSTGRES_PASSWORD=loons -e POSTGRES_DB=tlsdb postgres:16-alpine \
  -c ssl=on -c ssl_cert_file=/certs/postgres-tls.crt -c ssl_key_file=/certs/postgres-tls.key > /dev/null
docker run -d --name "$RD" --network "$NETWORK" --network-alias redis-tls -v "$VOLUME:/certs:ro" redis:7-alpine \
  redis-server --port 0 --tls-port 6379 --tls-cert-file /certs/redis-tls.crt --tls-key-file /certs/redis-tls.key \
  --tls-ca-cert-file /certs/ca.crt --tls-auth-clients no > /dev/null
for _ in $(seq 1 40); do
  docker exec "$PG" pg_isready -U loons -d tlsdb > /dev/null 2>&1 && break
  sleep 1
done
docker exec "$PG" pg_isready -U loons -d tlsdb > /dev/null && pass "PostgreSQL with TLS is up"
PG_IP="$(docker inspect -f '{{(index .NetworkSettings.Networks "'"$NETWORK"'").IPAddress}}' "$PG")"

# The URL documented in docs/DEPLOYMENT.md, with the bundle path of the images replaced by the test CA:
#   sslmode=verify-full                  node-postgres (API, worker): verify certificate and host name
#   sslrootcert=<bundle>                 node-postgres: the CA
#   sslcert=<bundle>, sslaccept=strict   Prisma Migrate: the CA, and "verify" instead of its default "accept any"
tls_query() { printf 'sslmode=verify-full&sslrootcert=%s&sslcert=%s&sslaccept=strict' "$1" "$1"; }
HOST=postgres-tls

migrate_status() { # url -> exit status; output in $LOG
  docker run --rm --network "$NETWORK" -v "$VOLUME:/certs:ro" -e "DATABASE_URL=$1" \
    loons-migrate:rehearsal prisma migrate status > "$LOG" 2>&1
}
reached_database() { grep -q -E "Following migrations have not yet been applied|Database schema is up to date|No migration found" "$LOG"; }
DB_SNIPPET="import { createPrismaClient } from '@loons/db'; const p = createPrismaClient({ url: process.env.DATABASE_URL }); try { const r = await p.\$queryRaw\`SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()\`; console.log('ssl=' + r[0].ssl); } catch (e) { console.log('error: ' + String(e.message).replace(/\s+/g, ' ').slice(0, 140)); } finally { await p.\$disconnect(); }"
driver() { # url -> "ssl=true" | "error: ..."
  docker run --rm --network "$NETWORK" -v "$VOLUME:/certs:ro" -e "DATABASE_URL=$1" \
    loons-api:rehearsal node --import tsx --input-type=module -e "$DB_SNIPPET" 2>&1 | grep -E '^(ssl=|error:)' | tail -1
}

echo "== Prisma Migrate (migrate image) with the documented URL"
URL="postgresql://loons:loons@$HOST:5432/tlsdb?$(tls_query /certs/ca.crt)"
if docker run --rm --network "$NETWORK" -v "$VOLUME:/certs:ro" -e "DATABASE_URL=$URL" loons-migrate:rehearsal > "$LOG" 2>&1 \
  && grep -q "All migrations have been successfully applied" "$LOG"; then
  pass "migrate deploy over verified TLS applies all migrations"
else
  fail "migrate deploy over verified TLS"
  tail -6 "$LOG" | sed 's/^/        /'
fi
if migrate_status "postgresql://loons:loons@$HOST:5432/tlsdb?sslmode=verify-full&sslaccept=strict"; then
  fail "migrate accepted a server certificate it cannot verify (no CA given)"
else
  pass "migrate refuses the connection when no CA is given"
fi
if migrate_status "postgresql://loons:loons@$PG_IP:5432/tlsdb?$(tls_query /certs/ca.crt)"; then
  fail "migrate accepted a host name that is not in the certificate (connected by IP address)"
else
  pass "migrate refuses a host name that is not in the certificate"
fi
if migrate_status "postgresql://loons:loons@$HOST:5432/tlsdb?$(tls_query /certs/other.crt)"; then
  fail "migrate accepted a certificate from a different CA"
else
  pass "migrate refuses a server certificate signed by a CA that is not the configured one"
fi

echo "== The API's database driver (api image: @loons/db -> node-postgres) with the same URL"
out="$(driver "postgresql://loons:loons@$HOST:5432/tlsdb?$(tls_query /certs/ca.crt)")"
if [ "$out" = "ssl=true" ]; then pass "node-postgres connects over TLS and verifies the server (pg_stat_ssl.ssl = true)"; else fail "driver over TLS: $out"; fi
out="$(driver "postgresql://loons:loons@$HOST:5432/tlsdb?sslmode=verify-full")"
case "$out" in
  error:*) pass "node-postgres refuses an unknown CA ($out)" ;;
  *) fail "driver accepted an unverifiable certificate: $out" ;;
esac
out="$(driver "postgresql://loons:loons@$PG_IP:5432/tlsdb?$(tls_query /certs/ca.crt)")"
case "$out" in
  error:*) pass "node-postgres refuses a host name that is not in the certificate ($out)" ;;
  *) fail "driver accepted a wrong host name: $out" ;;
esac

echo "== A bundle with several CA certificates (the RDS bundle has about 100)"
out="$(driver "postgresql://loons:loons@$HOST:5432/tlsdb?$(tls_query /certs/bundle-right-last.pem)")"
if [ "$out" = "ssl=true" ]; then pass "node-postgres uses every certificate of a bundle (the right CA is last)"; else fail "driver with the right CA last in the bundle: $out"; fi
if migrate_status "postgresql://loons:loons@$HOST:5432/tlsdb?$(tls_query /certs/bundle-right-first.pem)" && reached_database; then
  pass "Prisma Migrate verifies against a bundle whose FIRST certificate is the right CA"
else
  fail "Prisma Migrate with the right CA first in the bundle"
fi
if migrate_status "postgresql://loons:loons@$HOST:5432/tlsdb?$(tls_query /certs/bundle-right-last.pem)" && reached_database; then
  pass "Prisma Migrate verifies against a bundle whose right CA is NOT first (it reads the whole bundle)"
else
  printf '  note  Prisma Migrate reads only the FIRST certificate of a bundle: with the right CA last it refuses.\n'
  printf '        For RDS, give the migrate task a CA file holding ONE certificate, the root of the server chain\n'
  printf '        (docs/DEPLOYMENT.md, section 4.3, "Making rds-ca.pem").\n'
fi
rm -f "$LOG"

echo "== The URL shape of docs/DEPLOYMENT.md: the whole bundle for node-postgres, ONE certificate for Prisma Migrate"
# sslrootcert = the bundle (right CA last: node-postgres reads all of it); sslcert = a single-certificate file
# (Prisma reads only the first certificate of its file) - the rds-ca.pem of the guide.
DOC_QUERY='sslmode=verify-full&sslrootcert=/certs/bundle-right-last.pem&sslcert=/certs/ca.crt&sslaccept=strict'
out="$(driver "postgresql://loons:loons@$HOST:5432/tlsdb?$DOC_QUERY")"
if [ "$out" = "ssl=true" ]; then pass "documented URL: node-postgres verifies against the bundle"; else fail "documented URL with the driver: $out"; fi
if migrate_status "postgresql://loons:loons@$HOST:5432/tlsdb?$DOC_QUERY" && reached_database; then
  pass "documented URL: Prisma Migrate verifies against the single-certificate file"
else
  fail "documented URL with Prisma Migrate"
fi
if migrate_status "postgresql://loons:loons@$HOST:5432/tlsdb?sslmode=verify-full&sslrootcert=/certs/bundle-right-last.pem&sslcert=/certs/other.crt&sslaccept=strict"; then
  fail "documented URL: Prisma Migrate accepted a single-certificate file of the wrong CA"
else
  pass "documented URL: Prisma Migrate refuses a single-certificate file of the wrong CA"
fi
rm -f "$LOG"

echo "== Redis over TLS (api image: ioredis, rediss://)"
REDIS_SNIPPET="import { createRedisClient, closeRedis } from './src/lib/redis.ts'; const c = createRedisClient(process.env.REDIS_URL); try { console.log('ping=' + await c.ping()); } catch (e) { console.log('error: ' + e.message); } finally { await closeRedis(c); }"
redis_ping() { # extra docker args..., url
  local url="${*: -1}"
  docker run --rm --network "$NETWORK" -v "$VOLUME:/certs:ro" "${@:1:$#-1}" -e "REDIS_URL=$url" \
    loons-api:rehearsal node --import tsx --input-type=module -e "$REDIS_SNIPPET" 2>&1 | grep -E '^(ping=|error:)' | tail -1
}
out="$(redis_ping -e NODE_EXTRA_CA_CERTS=/certs/ca.crt rediss://redis-tls:6379)"
if [ "$out" = "ping=PONG" ]; then pass "ioredis speaks TLS to a rediss:// server whose CA is trusted (ping=PONG)"; else fail "redis over TLS: $out"; fi
out="$(redis_ping rediss://redis-tls:6379)"
if [ "$out" = "ping=PONG" ]; then fail "ioredis accepted an untrusted certificate"; else pass "ioredis refuses a certificate from an unknown CA ($out)"; fi
out="$(redis_ping -e NODE_EXTRA_CA_CERTS=/certs/ca.crt redis://redis-tls:6379)"
if [ "$out" = "ping=PONG" ]; then fail "a plain redis:// URL reached a TLS-only server"; else pass "a plain redis:// URL cannot talk to a TLS-only server ($out)"; fi
