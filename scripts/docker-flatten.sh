#!/usr/bin/env bash
# Flattens a built image into a single-layer image to actually reclaim the
# disk space `rm -rf` layers only hide (whiteout files keep the deleted
# base-image bytes, e.g. Playwright's firefox/webkit, on disk underneath).
#
# `docker export | docker import` drops ALL image config (not just
# app-specific env vars) unless every field is restored explicitly via
# --change, so this script captures the source image's full config first.
# Known exception: `docker import --change` does not support HEALTHCHECK --
# the app's healthcheck is defined at the compose level instead so it
# survives flattening regardless.
#
# Usage: docker-flatten.sh <source-image> <dest-image>
set -euo pipefail

SRC="${1:?usage: docker-flatten.sh <source-image> <dest-image>}"
DEST="${2:?usage: docker-flatten.sh <source-image> <dest-image>}"

ENV_LIST=$(docker inspect --format '{{range .Config.Env}}{{.}}{{"\n"}}{{end}}' "$SRC")
CMD_JSON=$(docker inspect --format '{{json .Config.Cmd}}' "$SRC")
ENTRYPOINT_JSON=$(docker inspect --format '{{json .Config.Entrypoint}}' "$SRC")
WORKDIR=$(docker inspect --format '{{.Config.WorkingDir}}' "$SRC")
USER_CFG=$(docker inspect --format '{{.Config.User}}' "$SRC")
EXPOSED_PORTS=$(docker inspect --format '{{range $p, $_ := .Config.ExposedPorts}}{{$p}}{{"\n"}}{{end}}' "$SRC")
VOLUMES=$(docker inspect --format '{{range $v, $_ := .Config.Volumes}}{{$v}}{{"\n"}}{{end}}' "$SRC")

CHANGES=()

while IFS= read -r line; do
  [ -z "$line" ] && continue
  key="${line%%=*}"
  val="${line#*=}"
  CHANGES+=(--change "ENV ${key}=\"${val}\"")
done <<< "$ENV_LIST"

[ -n "$WORKDIR" ] && CHANGES+=(--change "WORKDIR $WORKDIR")
[ -n "$USER_CFG" ] && CHANGES+=(--change "USER $USER_CFG")

while IFS= read -r port; do
  [ -n "$port" ] && CHANGES+=(--change "EXPOSE $port")
done <<< "$EXPOSED_PORTS"

while IFS= read -r vol; do
  [ -n "$vol" ] && CHANGES+=(--change "VOLUME $vol")
done <<< "$VOLUMES"

if [ -n "$CMD_JSON" ] && [ "$CMD_JSON" != "null" ]; then
  CHANGES+=(--change "CMD $CMD_JSON")
fi
if [ -n "$ENTRYPOINT_JSON" ] && [ "$ENTRYPOINT_JSON" != "null" ]; then
  CHANGES+=(--change "ENTRYPOINT $ENTRYPOINT_JSON")
fi

CONTAINER_ID=$(docker create "$SRC")
trap 'docker rm -f "$CONTAINER_ID" >/dev/null 2>&1 || true' EXIT

docker export "$CONTAINER_ID" | docker import "${CHANGES[@]}" - "$DEST"

echo "Flattened $SRC -> $DEST"
docker images "$DEST" --format '{{.Repository}}:{{.Tag}}  {{.Size}}'
