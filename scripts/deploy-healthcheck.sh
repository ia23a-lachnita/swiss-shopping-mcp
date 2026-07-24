#!/usr/bin/env bash
# Polls the deployed app's health endpoint after `docker compose up`; if it
# never comes up healthy, rolls back to the previous image tag, redeploys,
# and fails the job either way so a bad deploy always gets investigated
# rather than silently left running broken.
#
# Usage: deploy-healthcheck.sh <compose-file> <project-dir> <service> <image-repo:tag>
set -euo pipefail

COMPOSE_FILE="${1:?usage: deploy-healthcheck.sh <compose-file> <project-dir> <service> <image-repo:tag>}"
PROJECT_DIR="${2:?missing project-dir}"
SERVICE="${3:?missing service}"
IMAGE_REF="${4:?missing image-repo:tag}"   # e.g. swiss-shopping-mcp:pi-slim
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/source-status}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-15}"
SLEEP_SECONDS="${SLEEP_SECONDS:-4}"

echo "Waiting for $HEALTH_URL to report healthy (up to $((MAX_ATTEMPTS * SLEEP_SECONDS))s)..."

attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || echo "000")
  if [ "$code" = "200" ]; then
    echo "Healthy after $attempt attempt(s) (HTTP $code)."
    exit 0
  fi
  echo "Attempt $attempt/$MAX_ATTEMPTS: not healthy yet (HTTP $code), retrying in ${SLEEP_SECONDS}s..."
  attempt=$((attempt + 1))
  sleep "$SLEEP_SECONDS"
done

echo "Deploy failed health check after $MAX_ATTEMPTS attempts. Rolling back to previous image..." >&2

PREVIOUS_REF="${IMAGE_REF}-previous"
if ! sudo docker image inspect "$PREVIOUS_REF" >/dev/null 2>&1; then
  echo "No previous image tag ($PREVIOUS_REF) available to roll back to -- leaving current state for manual inspection." >&2
  exit 1
fi

sudo docker tag "$PREVIOUS_REF" "$IMAGE_REF"
sudo docker compose -f "$COMPOSE_FILE" --project-directory "$PROJECT_DIR" up -d --no-deps "$SERVICE"

echo "Rolled back to previous image and redeployed. Re-checking health..." >&2
sleep "$SLEEP_SECONDS"
code=$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || echo "000")
if [ "$code" = "200" ]; then
  echo "Rollback succeeded (HTTP $code). Failing the job so the bad deploy still gets investigated." >&2
else
  echo "Rollback ALSO unhealthy (HTTP $code). Manual intervention required on the Pi." >&2
fi
exit 1
