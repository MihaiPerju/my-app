#!/usr/bin/env bash
# Docker Compose lifecycle, driven by NX: `bunx nx run compose:<target>` -> `bash tools/compose.sh <sub>`.
# Direct port of the old tasks/deploy_compose.py, contributed by the docker-compose capability.
#
# The two Compose roots docker is pointed at, the one-shot init root, and the cli package that
# carries the init step modules are all shipped by this capability (the per-service overlays they
# `include:` are gated on their owning capability, so these paths are always present when this file
# is). `init` derives its step list from the rendered compose.init.yaml, so it runs precisely the
# init steps the installed selection produced; `init-steps` prints that list and runs nothing, so
# the runner consumes it and the tests can assert it. Every `uv` invocation goes through
# `tools/uv.sh` (pins the index, drops AGENT); `docker` and `bash tools/*.sh` are called directly.
set -euo pipefail
# Export the registry variant's Python Basic-auth username for Docker build args. The wrapper is
# safe to source: it executes uv only when invoked directly.
. "${0%/*}/uv.sh"

COMPOSE="deploy/compose/compose.yaml"
DEV="deploy/compose/compose.dev.yaml"
INIT="deploy/compose/compose.init.yaml"

# Compose's project directory is deploy/compose, so on its own it never reads the root `.env` that
# `mistral apps init` writes. Pass that file explicitly: GATEWAY_PORT, KEYCLOAK_PORT, API_PORT,
# WEB_PORT, POSTGRES_PORT, BUCKET_PORT, COMPOSE_PROJECT_NAME, ... set there then take effect. An
# exported shell variable still wins over the file. A missing .env is not an error.
ENV_FILE=()
if [ -f .env ]; then
  ENV_FILE=(--env-file .env)
fi

# `docker compose` against one root, reading the root .env. The project name is the root file's
# `name:` (the app's name) unless COMPOSE_PROJECT_NAME or a `-p` argument overrides it.
dc() {
  local root="$1"
  shift
  docker compose ${ENV_FILE[@]+"${ENV_FILE[@]}"} -f "$root" "$@"
}

# The init steps to run locally, in order, read from the Compose init root this capability owns.
# `compose.init.yaml` defines one `init-<step>` service per step, authored in dependency order
# (migrations before the steps that need a schema, worker-dependent steps last), and gated so only
# the installed selection's steps render. The trailing aggregator service is named `init` with no
# suffix and carries no step of its own, so the `init-` prefix excludes it. Equivalent to the old
# `re.findall(r"^  init-(\S+):$", ...)`; no match is a clean empty result, not an error.
init_steps() {
  grep -oE '^  init-[^:]+:' "$INIT" | sed -E 's/^  init-(.+):/\1/' || true
}

# Start the full stack in Docker. Rebuilds images by default; `--no-build` reuses existing ones
# (`bunx nx run compose:up -- --no-build`). Any other argument is handed to `docker compose up`.
# Both branches end in `docker compose`, whose exit status is the target's -- deliberately no
# `return 0` here.
do_up() {
  if [ "${1:-}" = "--no-build" ]; then
    shift
    dc "$COMPOSE" up -d "$@"
  else
    dc "$COMPOSE" up -d --build "$@"
  fi
}

# The ID of every image the dev root runs, one per line. An image not built or pulled yet prints
# nothing, so the list only changes when a build produced a new image.
dev_image_ids() {
  local image
  dc "$DEV" config --images | while IFS= read -r image; do
    docker image inspect --format '{{.Id}}' "$image" 2>/dev/null || true
  done
}

# Start the hot-reload stack in the foreground, rebuilding first. Each dev container keeps its
# installed dependencies (/app/.venv, node_modules) in an anonymous volume, and Compose hands the
# previous container's volume to a rebuilt one, so a dependency added to the image never arrives.
# When the build changed an image, `--renew-anon-volumes` starts those volumes fresh. It recreates
# every container, so it is not passed when nothing was rebuilt. No `--remove-orphans`: it deletes
# every container of the project that this selection does not declare, so it is opt-in
# (`bunx nx run compose:dev -- --remove-orphans`).
do_dev() {
  local before renew=()
  before="$(dev_image_ids)"
  dc "$DEV" build
  if [ "$(dev_image_ids)" != "$before" ]; then
    renew=(--renew-anon-volumes)
  fi
  dc "$DEV" up ${renew[@]+"${renew[@]}"} "$@"
}

# Compose's interpolation environment for the runtime root, one KEY=value per line: the shell
# environment over the root .env, parsed by Compose's own rules (quotes, inline comments, `export`).
# tools/smoke.sh reads its ports and the OIDC client secret from here, so it probes exactly what
# Compose publishes instead of re-implementing the .env syntax.
do_env() {
  dc "$COMPOSE" config --environment "$@"
}

# Run every deployment init step locally, in order (`python -m cli <step>` via the uv wrapper).
# Each step is idempotent, so re-running is safe; a slimmer selection runs a shorter chain. `set -e`
# aborts on the first failing step, matching the old invoke `_run`; the trailing `return 0` keeps an
# empty chain (no init-* services rendered) a success rather than the while loop's EOF non-zero.
do_init() {
  local name
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    bash tools/uv.sh run --no-sync python -m cli "$name"
  done < <(init_steps)
  return 0
}

case "${1:-}" in
  up) shift; do_up "$@" ;;
  down) shift; dc "$COMPOSE" down "$@" ;;
  build-images) shift; dc "$COMPOSE" build "$@" ;;
  logs) shift; dc "$COMPOSE" logs -f "$@" ;;
  dev) shift; do_dev "$@" ;;
  dev-down) shift; dc "$DEV" down "$@" ;;
  env) shift; do_env "$@" ;;
  smoke) bash tools/smoke.sh ;;
  init) do_init ;;
  init-steps) init_steps ;;
  *)
    echo "usage: compose.sh {up|down|dev|dev-down|build-images|logs|env|smoke|init|init-steps}" >&2
    exit 2
    ;;
esac
