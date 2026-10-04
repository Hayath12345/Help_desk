# MinIO no longer publishes its official mc image (quay.io/minio/mc), and the Chainguard one has no shell,
# so the init script in docker-compose.yml runs in alpine with the mc binary copied in.
FROM cgr.dev/chainguard/minio-client:latest AS mc
FROM alpine:3
COPY --from=mc /usr/bin/mc /usr/local/bin/mc
