#!/usr/bin/env bash
# Postgres concern: Alembic schema migration and the live-Postgres contract runner. Direct port of
# the old tasks/postgres.py, now driven by NX: `bunx nx run db:<target>` -> `bash tools/db.sh <target>`.
#
# Discovered/activated by capability presence (the shipped project.json). The migration subcommands
# drive Alembic from the app-local `packages/py/db` project this capability ships. `test-pg-contract`
# runs the suites that need a live Postgres with pgvector and self-skips when none is installed; it
# folds in the search store contract only when the `search` package is importable -- that file is
# vendored under the registry subtree in EVERY app (so on-disk presence proves nothing), but the
# package imports only when `search` is actually selected. Every `uv` call goes through tools/uv.sh,
# which pins the index and drops AGENT.
set -euo pipefail
. "${0%/*}/lib.sh"

DB_DIR="packages/py/db"

# App-local live-Postgres contract suites follow the `test_*_pg.py` convention under
# packages/py/db/tests: each is overlaid by whichever feature capability owns the table, so it is
# present exactly when that capability is selected. They sit behind test-pg-contract, not the default
# test run, and are discovered below rather than named so a new feature suite is drop-in.

# The search store contract also needs a live Postgres but belongs to the deselectable `search`
# capability. Its file is vendored under the registry subtree in EVERY app, so its presence on disk
# proves nothing -- gate it on the search package being importable, which holds only when `search` is
# actually selected. Running it in place keeps its conftest.py/search_pg_support.py siblings
# resolvable.
SEARCH_STORE_PACKAGE="mistralai_capabilities.search"
SEARCH_CONTRACT_TEST=".mistral/repositories/mistralai-capabilities/capabilities/feature/search/package/py/tests/test_search_store_contract.py"

run_alembic() { bash tools/uv.sh run --no-sync --directory "$DB_DIR" alembic "$@"; }

# Apply all Alembic migrations. `heads`, not `head`: each capability that owns a table ships its
# baseline as an independent branch, so the set has one head per such capability until merged.
do_migrate() {
  run_alembic upgrade heads
}

# The revision message from whatever shape the caller used: `--message "two words"`,
# `--message=two words`, `-m "two words"`, or bare words (`db:revision -- two words`). Nx forwards
# each of those verbatim; words after a flag's value are appended to it, so an Nx
# `--args="--message=two words"` (which Nx splits at the space) still keeps the whole message.
revision_message() {
  local words=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --message=* | -m=*) words+=("${1#*=}") ;;
      --message | -m)
        shift
        [ "$#" -gt 0 ] && words+=("$1")
        ;;
      *) words+=("$1") ;;
    esac
    [ "$#" -gt 0 ] && shift
  done
  printf '%s' "${words[*]:-}"
}

# Autogenerate a new Alembic revision from the SQLModel metadata. A message is required: it names
# the file, and Alembic would otherwise write `<rev>_.py` with an "empty message" docstring. When
# the set has several heads (one per table-owning capability), the new revision is based on all of
# them (`--head heads`), so it both merges the branches and carries the diff in one file; a separate
# `alembic merge` would leave the database behind the new head and autogenerate refuses to run then.
do_revision() {
  local message heads
  message="$(revision_message "$@")"
  if [ -z "$message" ]; then
    echo 'usage: bunx nx run db:revision --message "describe the change"' >&2
    exit 2
  fi
  # `grep -c` exits 1 on a count of 0 (a set with no revisions yet), which is not an error here.
  heads="$(run_alembic heads | grep -c . || true)"
  if [ "$heads" -gt 1 ]; then
    run_alembic revision --autogenerate --head heads -m "$message"
  else
    run_alembic revision --autogenerate -m "$message"
  fi
}

# Revert Alembic migrations down to the given revision, defaulting to one step back. The first
# revision in an app with several table owners is based on every capability head (see do_revision),
# and Alembic answers `downgrade -1` from such a merge point with "Ambiguous walk"; stepping back to
# any one of its parents unapplies exactly that revision and leaves every baseline in place.
do_downgrade() {
  local rev="${1:-}" merge
  if [ -z "$rev" ]; then
    rev=-1
    merge="$(run_alembic current | awk '/\(mergepoint\)/ { print $1; exit }')"
    if [ -n "$merge" ]; then
      rev="$(run_alembic show "$merge" | awk -F'[:,] *' '/^Merges:/ { print $2; exit }')"
      rev="${rev:--1}"
    fi
  fi
  run_alembic downgrade "$rev"
}

# Select the live-Postgres contract suites present in this app, add the search store contract only
# when its package is importable (never merely on disk), and skip cleanly when nothing applies.
do_test_pg_contract() {
  local suites=() test
  for test in packages/py/db/tests/test_*_pg.py; do
    [ -f "$test" ] && suites+=("$test")
  done
  if bash tools/uv.sh run --no-sync python -c "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('$SEARCH_STORE_PACKAGE') else 1)"; then
    suites+=("$SEARCH_CONTRACT_TEST")
  fi
  [ "${#suites[@]}" -gt 0 ] || { skipped test-pg-contract "no live-Postgres suite is installed"; return 0; }
  bash tools/uv.sh run --no-sync pytest "${suites[@]}" -v
}

case "${1:-}" in
  migrate) do_migrate ;;
  revision)
    shift
    do_revision "$@"
    ;;
  downgrade) do_downgrade "${2:-}" ;;
  test-pg-contract) do_test_pg_contract ;;
  *)
    echo "usage: db.sh {migrate|revision|downgrade|test-pg-contract}" >&2
    exit 2
    ;;
esac
