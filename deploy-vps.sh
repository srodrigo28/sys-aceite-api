#!/usr/bin/env bash
# Deploy seguro da API: valida configuracao e banco antes de trocar o container.
set -Eeuo pipefail

APP_NAME="${APP_NAME:-sysaceite-api}"
IMAGE="${IMAGE:-sysaceite-api:latest}"
MIGRATE_IMAGE="${MIGRATE_IMAGE:-sysaceite-api:migrate}"
ENV_FILE="${ENV_FILE:-/etc/sysaceite/api.env}"
PORT="${PORT:-3333}"

if [[ ! -r "$ENV_FILE" ]]; then
  echo "ERRO: arquivo de ambiente ausente ou sem permissao: $ENV_FILE" >&2
  echo "Crie-o a partir de .env.vps.example e proteja-o com: chmod 600 $ENV_FILE" >&2
  exit 1
fi

docker build -t "$IMAGE" .
docker build --target migrate -t "$MIGRATE_IMAGE" .

# Falha aqui preserva o container atualmente em funcionamento.
docker run --rm --env-file "$ENV_FILE" "$MIGRATE_IMAGE" npm run db:migrate
docker run --rm --env-file "$ENV_FILE" "$IMAGE" npm run env:check:dist

docker rm -f "$APP_NAME" 2>/dev/null || true
docker run -d \
  --name "$APP_NAME" \
  --restart unless-stopped \
  --env-file "$ENV_FILE" \
  -p "$PORT:3333" \
  "$IMAGE"

echo "Aguardando healthcheck de $APP_NAME..."
for _ in {1..12}; do
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}starting{{end}}' "$APP_NAME")"
  if [[ "$status" == "healthy" ]]; then
    docker ps --filter "name=^/${APP_NAME}$"
    exit 0
  fi
  if [[ "$status" == "unhealthy" || "$(docker inspect --format '{{.State.Status}}' "$APP_NAME")" != "running" ]]; then
    docker logs --tail 100 "$APP_NAME" >&2
    exit 1
  fi
  sleep 5
done

echo "ERRO: healthcheck nao ficou saudavel a tempo" >&2
docker logs --tail 100 "$APP_NAME" >&2
exit 1
