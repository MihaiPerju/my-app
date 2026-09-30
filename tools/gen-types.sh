#!/usr/bin/env bash
# The typed web API client, generated from the FastAPI OpenAPI contract. Contributed by the hidden
# `fastapi-tanstack-start` capability and driven by NX:
# `bunx nx run fastapi-tanstack-start:gen-types` -> `bash tools/gen-types.sh`,
# `fastapi-tanstack-start:gen-types-check` -> `bash tools/gen-types.sh --check`.
#
# `generate` dumps apps/api/openapi.json from the app's routes and regenerates apps/web/src/api/generated.
#
# `--check` is the drift gate: it regenerates both and fails if either differs from what was on disk
# before. It compares against the working tree, not the git index, so a correct regeneration that is
# not staged yet passes locally; CI checks out a clean tree, where the two are the same thing. The
# regenerated files are left in place, so a stale client is fixed by the run that reports it.
#
# The scaffold ships the client generated for the registry's full composition, because the CLI only
# copies files. An app that selects fewer API capabilities regenerates it once: `bun run install-all`
# runs this script, and the result is a diff to commit.
set -euo pipefail

SPEC="apps/api/openapi.json"
CLIENT="apps/web/src/api/generated"

generate() {
  bash tools/uv.sh run --no-sync gen-openapi "$SPEC"
  (cd apps/web && bunx @hey-api/openapi-ts)
}

BEFORE=""
cleanup() { [ -z "$BEFORE" ] || rm -rf "$BEFORE"; }

check() {
  local had_spec=0 drift=0
  BEFORE="$(mktemp -d)"
  trap cleanup EXIT
  cp -R "$CLIENT" "$BEFORE/client"
  if [ -f "$SPEC" ]; then
    cp "$SPEC" "$BEFORE/openapi.json"
    had_spec=1
  fi

  generate

  diff -ru "$BEFORE/client" "$CLIENT" >"$BEFORE/diff" || drift=1
  # A spec that was never written has nothing to drift from; the client is the contract.
  if [ "$had_spec" = 1 ]; then
    diff -u "$BEFORE/openapi.json" "$SPEC" >>"$BEFORE/diff" || drift=1
  fi
  if [ "$drift" = 1 ]; then
    head -n 60 "$BEFORE/diff"
    echo "The generated API client did not match the API's routes (first 60 diff lines above)." >&2
    echo "It has been regenerated in place; review the change and commit it:" >&2
    echo "  git add $SPEC $CLIENT" >&2
    exit 1
  fi
  echo "[check] generated API client matches the API"
}

case "${1:-}" in
  "") generate ;;
  --check) check ;;
  *)
    echo "usage: gen-types.sh [--check]" >&2
    exit 2
    ;;
esac
