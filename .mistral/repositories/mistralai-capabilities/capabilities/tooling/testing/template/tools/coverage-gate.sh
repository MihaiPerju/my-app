#!/usr/bin/env bash
# Fail when aggregate line coverage of an lcov report drops below a floor.
#
# bun test emits lcov but applies `coverageThreshold` per FILE, so it cannot gate on the total.
# This gate is the total-coverage counterpart of pytest's `--cov-fail-under`.
# Raise the floor as coverage improves. Never lower it.
set -euo pipefail

usage() {
  echo "usage: coverage-gate.sh <lcov.info> <min-line-percent>" >&2
  exit 2
}

report="${1:-}"
minimum="${2:-}"
[[ -n "${report}" && -n "${minimum}" ]] || usage

if [[ ! -f "${report}" ]]; then
  echo "coverage-gate: no lcov report at ${report} — did the test run use --coverage?" >&2
  exit 1
fi

# lcov `DA:<line>,<hit-count>` — one record per executable line, under the `SF:<path>` of its file.
#
# Only the suite's own source counts. bun records every file the tests load, with paths relative to
# the directory the suite ran in, so a workspace library the app imports shows up as `../../...`
# (for example the vendored `@mistral/markdown` parser, which is most of the lines when the chat
# feature is installed). That library has its own tests. Counting it here made the total depend on
# which capabilities are installed rather than on how well the app's own code is tested. Absolute
# paths and anything under node_modules are outside the suite too.
read -r covered total percent foreign < <(
  awk -F'[:,]' '
    /^SF:/ {
      path = substr($0, 4)
      own = !(path ~ /^\.\.\// || path ~ /^\// || path ~ /(^|\/)node_modules\//)
    }
    /^DA:/ {
      if (!own) { foreign++; next }
      total++
      if ($3 + 0 > 0) covered++
    }
    END { printf "%d %d %.2f %d\n", covered, total, (total ? covered * 100 / total : 0), foreign }
  ' "${report}"
)

if [[ "${foreign}" -gt 0 ]]; then
  printf 'coverage-gate: not gating %s lines loaded from outside the suite (workspace libraries)\n' \
    "${foreign}"
fi

if [[ "${total}" -eq 0 ]]; then
  echo "coverage-gate: ${report} records no executable lines" >&2
  exit 1
fi

printf 'coverage-gate: %s/%s lines covered (%s%%), floor %s%%\n' \
  "${covered}" "${total}" "${percent}" "${minimum}"

if awk -v have="${percent}" -v want="${minimum}" 'BEGIN { exit !(have + 0 < want + 0) }'; then
  echo "coverage-gate: FAILED — line coverage ${percent}% is below the ${minimum}% floor" >&2
  exit 1
fi
