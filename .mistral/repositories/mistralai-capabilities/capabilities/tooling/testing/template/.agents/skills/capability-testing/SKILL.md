---
name: capability-testing
description: The app's Python test infrastructure — the root pytest/coverage config, the pre-collection `conftest` bootstrap, the two coverage ratchets, and the generated-workspace contract tests. Use when the suite will not collect or behaves differently from your shell, when adding a workspace member to `testpaths` or changing a coverage floor, when a contract test (env parity, lock provenance, testpaths, task surface) fails, or when wiring the `test`/`test-cov`/`test-web-cov`/`check` targets.
---

# Testing

Owns *how the Python suite runs and what gates it*: root `pytest.ini` + `.coveragerc`, the workspace-wide `conftest.py` bootstrap, the coverage ratchets, and contract tests asserting the generated workspace is internally consistent. It does **not** own feature tests — every capability ships its own `tests/`, collected here once installed. Template-only, `core` its sole dep. Adjacent surface lives elsewhere: web suite + Bun (`tanstack-start`), live-Postgres `test-pg-contract` (`postgres`), sourced `tools/lib.sh` / `tools/uv.sh` (`core`).

## Where things live

| Path | What |
| --- | --- |
| `pytest.ini` | Root config: `asyncio_mode=auto`, `testpaths` as globs (`tests`, `packages/py/*/tests`, `apps/*/tests`), so collection follows the installed selection. |
| `.coveragerc` | Coverage: `omit`s (tests, conftest, migrations, process entrypoints), `branch=true`, `exclude_also`. No `source`: `tools/testing.sh` discovers the roots. |
| `conftest.py` | Workspace bootstrap, imported before any test module. |
| `packages/py/testing/pyproject.toml` | Dep-only member (`package=false`); `dev` group carries pytest, pytest-asyncio, pytest-cov, pyyaml, respx. |
| `tools/testing.sh` | `test`/`test-cov`/`test-web-cov`/`check` runners; holds the coverage floors; `cov-sources` prints the discovered `--cov=` roots. |
| `tools/coverage-gate.sh` | lcov aggregate-coverage ratchet `test-web-cov` calls. Counts only the suite's own files, not `../../` workspace libraries the tests load. |
| `tasks/testing/project.json` | `testing` NX project exposing the four targets. |
| `tests/test_composed_env_contract.py` | Env parity: every settings field is declared by an installed capability's `envVars` (read from the committed `.mistral` ledger, so it runs in a fresh clone) or by name in the committed `.env.example` (the app's own settings), and the runtime env loads every settings class. |
| `tests/test_lock_provenance.py` | Dependency-confusion guard: each locked pkg came from its bound index. |
| `tests/test_workspace_config.py` | Every member shipping `tests/` is matched by a `testpaths` glob. |
| `tests/test_testing_tasks.py` | Target surface, web-skip seam, pinned coverage floors. |

## Extend

- **New workspace member with `tests/`**: nothing to do under `packages/py/<name>/` or `apps/<name>/`; the `testpaths` globs collect it. Elsewhere, add its dir to `testpaths`, else `test_workspace_config.py` fails.
- **Change a coverage floor**: edit the inlined `--cov-fail-under=81` (Python) or `WEB_COVERAGE_MIN=56` (web, via `coverage-gate.sh`) in `tools/testing.sh`. Only raise — lowering fails `test_coverage_floors_are_preserved`.
- **New coverage source tree**: `packages/py/<name>/src` and Python `apps/<name>/src` are measured automatically. Elsewhere, add it to `cov_sources` in `tools/testing.sh`.
- **New app setting** (`packages/py/env/src/env/<name>.py`): give the field its default, and declare the bare name (`MY_SETTING=`, no value) in the root `.env.example`, else `test_composed_env_contract.py` fails. Nothing loads `.env.example`, so a value there is rejected; set one in `.env` only to override the default.
- **Cross-cutting test-env setup**: put it in root `conftest.py` (runs before collection), not per-test hacks.
- **Which suite?** Suite-wide config/gates or a cross-capability consistency check → here; one capability's behavior → its own `tests/` (auto-collected once on `testpaths`).

## Gotchas

- `conftest.py` pops stray `AGENT` (else `mistralai.workflows` `WorkerConfig` aborts collection) and sets `WORKFLOWS_ENCRYPTION_MODE=off` to keep the suite offline.
- `tools/testing.sh` sources `tools/lib.sh` and routes `uv` through `tools/uv.sh` — **both ship with `core`, not here**.
- `test-web-cov` skips (exit 0, `[check] SKIPPED`) on a web-less app instead of failing.
