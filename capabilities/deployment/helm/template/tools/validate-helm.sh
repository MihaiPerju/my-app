#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="$ROOT_DIR/deploy/helm/app"
PRODUCTION_VALUES="$CHART_DIR/values-production.yaml"

for command in helm kubeconform; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "error: $command is required" >&2
    exit 1
  fi
done

validate() {
  local profile="$1"
  shift

  echo "Validating Helm chart ($profile values)"
  helm lint "$CHART_DIR" "$@"
  helm template mistralai-capabilities "$CHART_DIR" "$@" |
    kubeconform -strict -summary -ignore-missing-schemas
}

validate default
validate production -f "$PRODUCTION_VALUES"
