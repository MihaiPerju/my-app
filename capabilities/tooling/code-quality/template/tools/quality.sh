#!/usr/bin/env bash
# Code-quality checks and fixers, discovered/applied by file presence. Direct port of the old
# tasks/quality.py, now driven by NX: `bunx nx run quality:<target>` -> `bash tools/quality.sh <target>`.
#
# Each subcommand infers applicability from what the app actually ships, so a Python-only app runs
# nothing for the TS steps, an app with no lockfiles skips the audit, and an app with no shell
# scripts skips shellcheck -- the same file-presence gating the invoke tasks did. The discovery
# subcommands (`py-targets`, `shell-scripts`, `dockerfiles`) print their result and run nothing, so
# the runner consumes them and the tests can assert them. Every `uv` invocation goes through
# `tools/uv.sh`, which pins the index and drops AGENT; `require uv` still gates on the real binary.
# `skipped`/`require` come from the shared `tools/lib.sh`.
set -euo pipefail
shopt -s nullglob
. "${0%/*}/lib.sh"

HADOLINT_IMAGE="hadolint/hadolint:v2.14.0"
UV_HINT="https://docs.astral.sh/uv/ (curl -LsSf https://astral.sh/uv/install.sh | sh); then 'bun run install-all'"
BUN_HINT="https://bun.sh/docs/installation (curl -fsSL https://bun.sh/install | bash); then 'bun run install-all'"

has_python() { [ -f pyproject.toml ]; }

# Files matching `$1` (a -name pattern), pruning the ignored trees; paths relative and sorted.
discover() {
  find . \
    \( -type d \( -name .git -o -name .venv -o -name venv -o -name node_modules -o -name .mistral -o -name .nx \) -prune \) \
    -o \( -type f -name "$1" -print \) \
    | sed 's|^\./||' | LC_ALL=C sort
}

# Every Python source root present on disk, inferred from the workspace layout: library packages at
# packages/py/<name>/src, and a Python app module at apps/<name>/src beside its own pyproject.toml
# (which is what excludes the TS apps/web). ty refuses to start on a missing root, so this is what
# actually exists, not a fixed list.
py_targets() {
  local src app
  for src in packages/py/*/src; do
    [ -d "$src" ] && echo "$src"
  done
  for app in apps/*; do
    [ -f "$app/pyproject.toml" ] && [ -d "$app/src" ] && echo "$app/src"
  done
  return 0
}

do_lint() {
  has_python || { skipped lint "no Python workspace (pyproject.toml absent)"; return 0; }
  require uv "$UV_HINT"
  bash tools/uv.sh run --no-sync ruff check .
}

do_fmt() {
  has_python || { skipped fmt "no Python workspace (pyproject.toml absent)"; return 0; }
  require uv "$UV_HINT"
  bash tools/uv.sh run --no-sync ruff format .
}

do_fmt_check() {
  has_python || { skipped fmt-check "no Python workspace (pyproject.toml absent)"; return 0; }
  require uv "$UV_HINT"
  bash tools/uv.sh run --no-sync ruff format --check .
}

do_typecheck() {
  local roots=() root
  while IFS= read -r root; do roots+=("$root"); done < <(py_targets)
  [ "${#roots[@]}" -gt 0 ] || { skipped typecheck "no Python source roots present"; return 0; }
  require uv "$UV_HINT"
  bash tools/uv.sh run --no-sync ty check "${roots[@]}"
}

# Scan the present dependency graphs for known vulnerabilities. Each scanner prints everything and
# fails only above a severity floor. Neither can see the private packages (public advisory DBs carry
# no records for private names) -- a real blind spot, not a bug.
do_audit() {
  local ran=0
  if [ -f bun.lock ] || [ -f bun.lockb ]; then
    require bun "$BUN_HINT"
    bun audit || true
    bun audit --audit-level=critical
    ran=1
  fi
  if [ -f uv.lock ]; then
    require uv "$UV_HINT"
    # --no-check-uv-tool/--no-check-uv-secure: audit this repo's lockfile, not the machine's own uv.
    bash tools/uv.sh run --no-sync uv-secure uv.lock --no-check-uv-tool --no-check-uv-secure --show-severity || true
    bash tools/uv.sh run --no-sync uv-secure uv.lock --no-check-uv-tool --no-check-uv-secure --severity high
    ran=1
  fi
  [ "$ran" -eq 1 ] || skipped audit "no dependency lockfiles present (run 'bun run lock' / 'bun install' first)"
}

do_lint_shell() {
  local scripts=() script
  while IFS= read -r script; do scripts+=("$script"); done < <(discover '*.sh')
  [ "${#scripts[@]}" -gt 0 ] || { skipped lint-shell "no shell scripts present"; return 0; }
  require shellcheck "https://www.shellcheck.net/ (brew install shellcheck | apt-get install shellcheck)"
  shellcheck -x "${scripts[@]}"
}

do_lint_docker() {
  local dockerfiles=() dockerfile
  while IFS= read -r dockerfile; do dockerfiles+=("$dockerfile"); done < <(discover 'Dockerfile*')
  [ "${#dockerfiles[@]}" -gt 0 ] || { skipped lint-docker "no Dockerfiles present"; return 0; }
  require docker "https://docs.docker.com/get-docker/"
  # Mount the workspace read-only and lint the files by path, from the workspace root. That is where
  # hadolint looks for the committed .hadolint.yaml; stdin mode (`hadolint -`) would never read it.
  # One run over every file also reports all findings with real file names, not just the first file.
  docker run --rm -v "$PWD:/workspace:ro" -w /workspace "$HADOLINT_IMAGE" \
    hadolint --no-color "${dockerfiles[@]}"
}

# The web/TypeScript half of the full gate: format, lint, then type-check. The type-aware lint needs
# the generated TanStack route tree; the root `check` script builds first, so the tree already exists
# and this target stays a leaf in the graph (no nested nx).
do_check_ts() {
  require bun "$BUN_HINT"
  bunx oxfmt --check apps packages
  bunx oxlint apps packages
  bunx oxlint --type-aware --type-check apps packages
}

# Auto-fix what can be auto-fixed. Fix-only by design: the combined fix-then-check UX is exposed as
# the quality project's `fix` target, so this script never launches NX from inside itself.
do_fix() {
  if has_python; then
    require uv "$UV_HINT"
    bash tools/uv.sh run --no-sync ruff check --fix .
    bash tools/uv.sh run --no-sync ruff format .
  fi
  require bun "$BUN_HINT"
  bunx oxfmt --write apps packages
  bunx oxlint --fix apps packages
}

case "${1:-}" in
  py-targets) py_targets ;;
  shell-scripts) discover '*.sh' ;;
  dockerfiles) discover 'Dockerfile*' ;;
  lint) do_lint ;;
  fmt) do_fmt ;;
  fmt-check) do_fmt_check ;;
  typecheck) do_typecheck ;;
  audit) do_audit ;;
  lint-shell) do_lint_shell ;;
  lint-docker) do_lint_docker ;;
  check-ts) do_check_ts ;;
  fix) do_fix ;;
  *)
    echo "usage: quality.sh {lint|fmt|fmt-check|typecheck|audit|lint-shell|lint-docker|check-ts|fix|py-targets|shell-scripts|dockerfiles}" >&2
    exit 2
    ;;
esac
