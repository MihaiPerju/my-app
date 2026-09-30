#!/usr/bin/env bash
# Report the dev tools a Mistral Apps machine needs: one `ok`, `missing`, `outdated`, `mismatch`,
# `down` or `denied` line per tool. Exits non-zero when anything is not `ok`.
# Minimums follow the mistralai-capabilities README prerequisites; node's is the `skills` CLI's.
# Bun is exact: generated apps pin `packageManager: bun@<version>` and `bun run install-all` rejects
# any other version, so keep BUN_VERSION on core's template/package.json pin.
# Run it through the user's login shell (`$SHELL -ic 'bash check-tools.sh'`) so it sees their PATH.
set -uo pipefail

status=0
BUN_VERSION=1.4.0

report() {
  printf '%-8s %-8s %s\n' "$1" "$2" "$3"
  [[ "$1" == ok ]] || status=1
}

version_of() {
  "$@" 2>/dev/null | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1
}

# at_least <have> <min>: compare dotted versions part by part (no `sort -V`, absent on BusyBox).
at_least() {
  local IFS=. i
  local -a have want
  read -r -a have <<<"$1"
  read -r -a want <<<"$2"
  for i in 0 1 2; do
    ((10#${have[i]:-0} > 10#${want[i]:-0})) && return 0
    ((10#${have[i]:-0} < 10#${want[i]:-0})) && return 1
  done
  return 0
}

check() {
  local name="$1" min="$2" have
  shift 2
  if ! command -v "$name" >/dev/null; then
    report missing "$name" "needs >= $min"
    return
  fi
  have="$(version_of "$@")"
  if [[ -z "$have" ]] || ! at_least "$have" "$min"; then
    report outdated "$name" "${have:-unknown}, needs >= $min"
  else
    report ok "$name" "$have"
  fi
}

# check_exact <name> <version> <cmd…>: like check, but only the exact version is ok.
check_exact() {
  local name="$1" pin="$2" have
  shift 2
  if ! command -v "$name" >/dev/null; then
    report missing "$name" "needs exactly $pin"
    return
  fi
  have="$(version_of "$@")"
  if [[ "$have" != "$pin" ]]; then
    report mismatch "$name" "${have:-unknown}, needs exactly $pin"
  else
    report ok "$name" "$have"
  fi
}

check git 2.0 git --version
check node 22.20.0 node --version
check_exact bun "$BUN_VERSION" bun --version
check uv 0.11.17 uv --version
check gh 2.0 gh --version
check playwright-cli 0.1.21 playwright-cli --version

if command -v uv >/dev/null; then
  if py="$(uv python find 3.14 2>/dev/null)"; then
    report ok python "3.14 ($py)"
  else
    report missing python "3.14, via uv"
  fi
else
  report missing python "3.14, install uv first"
fi

if ! command -v docker >/dev/null; then
  report missing docker "with BuildKit"
elif ! docker_err="$(docker version --format '{{.Server.Version}}' 2>&1 >/dev/null)"; then
  if [[ "$docker_err" == *"permission denied"* ]]; then
    report denied docker "the user is not in the docker group"
  else
    report down docker "installed, but the daemon is not running"
  fi
elif ! docker buildx version >/dev/null 2>&1; then
  report missing buildx "Docker BuildKit plugin"
else
  report ok docker "$(version_of docker version --format '{{.Server.Version}}')"
fi

if command -v gh >/dev/null && ! gh auth status >/dev/null 2>&1; then
  report missing gh-auth "run: gh auth login"
fi

exit "$status"
