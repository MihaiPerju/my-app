#!/usr/bin/env bash
# Converge the platform's recurring workflow schedules (the schedules step of init), self-skipping
# when the implementation it drives is absent. Driven by NX: `bunx nx run worker:register-schedules` ->
# `bash tools/worker-schedules.sh`.
#
# The `schedules` command ships with the optional evals capability (which depends on workflows), not with
# workflows itself, so a workflows-only app still advertises `register-schedules` but must not fail
# invoking an implementation it never installed -- hence the file-presence skip. The `uv` call goes
# through tools/uv.sh, which pins the index and drops AGENT.
set -euo pipefail
. "${0%/*}/lib.sh"

SCHEDULES_CMD="packages/py/cli/src/cli/commands/schedules.py"

if [ ! -f "$SCHEDULES_CMD" ]; then
  skipped register-schedules "evals capability not installed (no schedules command)"
  exit 0
fi
bash tools/uv.sh run --no-sync python -m cli schedules
