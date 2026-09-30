#!/usr/bin/env bash
# Leaves the compose stack running; the two share no state.
set -euo pipefail

CLUSTER="${K3D_CLUSTER:-scapp}"

command -v k3d >/dev/null 2>&1 || { echo "error: k3d is not installed" >&2; exit 1; }

if k3d cluster list "$CLUSTER" >/dev/null 2>&1; then
  k3d cluster delete "$CLUSTER"
  echo "deleted cluster $CLUSTER"
else
  echo "cluster $CLUSTER does not exist, nothing to do"
fi
