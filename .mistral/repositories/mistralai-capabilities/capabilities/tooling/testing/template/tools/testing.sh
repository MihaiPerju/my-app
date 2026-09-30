#!/usr/bin/env bash
# Test and coverage runners, contributed by the optional `testing` capability. Direct port of the old
# tasks/testing.py, now driven by NX: `bunx nx run testing:<target>` -> `bash tools/testing.sh <target>`.
#
# `test` is the fast, uncovered dev loop. `test-cov` runs the Python suite under coverage and enforces
# the ratchet (CI job `py-test`). `test-web-cov` runs the web suite's coverage ratchet (CI job
# `ts-checks`), but only when this app ships a web suite: a supported `core + testing` composition has
# no apps/web, so the step skips rather than fails, keeping the aggregated `check` gate green on a
# web-less app. `check` is this concern's contribution to that gate -- the two coverage-ratcheted
# suites. Every `uv` invocation goes through `tools/uv.sh`, which pins the index and drops AGENT.
#
# The floors are the coverage measured when the gates were introduced: 81% of first-party Python lines
# (re-baselined once vendored toolkits left the coverage source list) and 56% of the web app's own
# executable lines. Both gates measure only the app's own source, never a workspace library or
# capability toolkit the tests happen to load (see .coveragerc and coverage-gate.sh). Raise them as
# coverage improves; lowering one makes the gate stop being a gate.
set -euo pipefail
. "${0%/*}/lib.sh"

# The web suite's lcov output and its ratchet floor. (The Python floor is inlined in test-cov.)
WEB_LCOV="apps/web/coverage/lcov.info"
WEB_COVERAGE_MIN=56

do_test() {
  bash tools/uv.sh run --no-sync pytest
}

# The first-party Python source roots that exist, as `--cov=<root>` arguments: every library package
# at packages/py/<name>/src and every Python app at apps/<name>/src (beside its own pyproject.toml,
# which is what leaves the TS apps/web out). Discovered rather than listed, like quality.sh's
# typecheck roots, so coverage follows the installed capabilities and any package the app adds.
cov_sources() {
  local src app
  for src in packages/py/*/src; do
    [ -d "$src" ] && echo "--cov=$src"
  done
  for app in apps/*; do
    [ -f "$app/pyproject.toml" ] && [ -d "$app/src" ] && echo "--cov=$app/src"
  done
  return 0
}

do_test_cov() {
  local sources=() root
  while IFS= read -r root; do sources+=("$root"); done < <(cov_sources)
  [ "${#sources[@]}" -gt 0 ] || sources=(--cov)
  bash tools/uv.sh run --no-sync pytest "${sources[@]}" --cov-report=term-missing:skip-covered \
    --cov-report=xml --cov-fail-under=81
}

# The web coverage ratchet is contributed to the gate only when the web app is present. A supported
# `core + testing` composition has no apps/web, so skip rather than fail when it is absent.
do_test_web_cov() {
  [ -d apps/web ] || { skipped test-web-cov "no web app (apps/web absent)"; return 0; }
  bun run --cwd apps/web test --coverage
  bash tools/coverage-gate.sh "$WEB_LCOV" "$WEB_COVERAGE_MIN"
}

# This concern's contribution to the neutral `check` aggregator: the two coverage-ratcheted suites.
do_check() {
  do_test_cov
  do_test_web_cov
}

case "${1:-}" in
  test) do_test ;;
  test-cov) do_test_cov ;;
  test-web-cov) do_test_web_cov ;;
  check) do_check ;;
  cov-sources) cov_sources ;;
  *)
    echo "usage: testing.sh {test|test-cov|test-web-cov|check|cov-sources}" >&2
    exit 2
    ;;
esac
