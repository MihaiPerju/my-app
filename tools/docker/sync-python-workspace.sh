#!/bin/sh
# Canonical container build-time installer for the generated Python workspace.
# Usage: sync-python-workspace.sh <dependencies|runtime|dev>
set -eu

phase=${1:?missing sync phase}
case "$phase" in
  dependencies)
    exec uv sync --all-packages --frozen --no-dev --no-install-workspace
    ;;
  runtime)
    exec uv sync --all-packages --frozen --no-dev
    ;;
  dev)
    exec uv sync --all-packages --frozen
    ;;
  *)
    echo "unknown sync phase: $phase" >&2
    exit 2
    ;;
esac
