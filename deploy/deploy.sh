#!/usr/bin/env bash
# Neue Version ausrollen (wird von GitHub Actions per SSH aufgerufen, geht aber auch von Hand):
#   ssh deploy@<server> 'bash /opt/czarina-video-worker/deploy/deploy.sh'
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

echo "==> git pull"
git fetch --prune origin
git reset --hard origin/main

echo "==> Image bauen und Container austauschen"
cd deploy
docker compose build --pull worker
docker compose up -d --remove-orphans

echo "==> Alte Images aufräumen"
docker image prune -f >/dev/null

echo "==> Health-Check"
for i in $(seq 1 20); do
  if docker compose exec -T worker curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1; then
    echo "OK – Worker läuft."; exit 0
  fi
  sleep 3
done
echo "Worker antwortet nicht – Logs:" >&2
docker compose logs --tail=50 worker >&2
exit 1
