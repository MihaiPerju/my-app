---
name: capability-code-quality
description: The generated app's repository quality gate — ruff + ty for Python, the oxlint/oxfmt stack with the local anti-slop plugin for TypeScript, dependency auditing, shell/Dockerfile linting, pre-commit hooks, and the file-presence-driven `check`/`fix` NX workflow. Use when a `check`/`fix`/`typecheck` target skips or fails unexpectedly, when adding or tuning a linter/formatter/type rule, when a new Python package is not being type-checked, or when writing or wiring an anti-slop oxlint rule.
---

# Code quality

The repository quality gate: linter/formatter/type-checker configs, pre-commit hooks, the local
anti-slop oxlint plugin, and the `quality` NX project whose `check`/`fix` targets run them. Owns the
gate + config only (each runtime/db/feature capability supplies its own sources); every step infers
applicability from files on disk (skip explicitly, exit 0), so it composes with any selection. Depends
only on `core` (extends its workspace root; reuses `tools/lib.sh` `skipped`/`require` + `tools/uv.sh`).

## Where things live

| Path | What |
| --- | --- |
| `tools/quality.sh` | Runner every target shells to; one file-presence-gated `do_*` per step. `py-targets`/`shell-scripts`/`dockerfiles` are pure-discovery subcommands. |
| `tasks/quality/project.json` | `quality` NX project: atomic targets (`lint`,`fmt`,`fmt-check`,`typecheck`,`audit`,`lint-shell`,`lint-docker`,`check-ts`,`fix`) + `check`, a graph aggregator that `dependsOn` the seven gate steps. |
| `ruff.toml` | Ruff lint+format: line-length 120, `E/F/W/Q/I/T201/ASYNC/B/UP/RUF/FAST/PGH003`, per-file ignores. |
| `ty.toml` | ty config: `root` = core packages only; excludes the path-loaded agent tree. |
| `.oxlintrc.json` | Oxlint: builtin + `typeAware`, local `anti-slop` + `@shadcn/lint` jsPlugins, 15 anti-slop rules as errors, test overrides. |
| `.oxfmtrc.json` | Oxfmt — ignore patterns only. |
| `.pre-commit-config.yaml` | gitleaks, hygiene hooks, nbstripout, local `block-*` no-secrets/no-data-export hooks. Compose files get a syntax-only `check-yaml --unsafe`, so `!override`/`!reset` pass. |
| `.shellcheckrc`, `.hadolint.yaml` | `lint-shell` / `lint-docker` policy: resolve sibling `source`s from the script's dir; ignore DL3008 (reason in the file). hadolint runs with the workspace mounted, so it reads this file. |
| `tools/oxlint/anti-slop/` | Local oxlint jsPlugin: `index.ts` registers 15 rules from `rules/`, `shared/` type-resolution helpers, `effect/` opt-in sub-plugin (not wired). |
| `packages/ts/code-quality/` | Private `@app/code-quality` carrying oxlint/oxfmt/plugin `devDependencies`. |
| `packages/py/code-quality/pyproject.toml` | `code-quality` py workspace: ruff/ty/uv-secure/pre-commit in `dev` group, `package = false`. |
| `tests/test_quality_tasks.py`, `tests/test_typecheck_targets.py` | Defend target set/discovery/skip-vs-fail; py type-check coverage + core-only `ty.toml` roots. |

## Extend

- **New gate step:** add a file-presence-gated `do_*` in `quality.sh`, an atomic target in `project.json`, and (if part of the full gate) add it to `check`'s `dependsOn`.
- **Tune a rule:** edit `ruff.toml` (Python) or `.oxlintrc.json` / `.oxfmtrc.json` (TS).
- **New anti-slop rule:** drop it in `tools/oxlint/anti-slop/rules/`, register in `index.ts`, enable in `.oxlintrc.json`. Wire the `effect/` sub-plugin in only for an Effect codebase.
- **New Python source root** is auto-discovered by `quality.sh py-targets` (`packages/py/*/src` + `apps/*/src` beside a `pyproject.toml`); never add optional roots to `ty.toml`.

## Gotchas

- `ty.toml` `root` must stay core-only (`packages/py/utils/src`, `packages/py/env/src`) — ty refuses to start on a missing root, breaking `typecheck` for apps that deselected the owning capability.
- After `fix`, run `check` — `quality.sh` never launches NX from inside itself.
- `audit` cannot see private packages (public advisory DBs only) — a real blind spot, not a bug.
- **Parse boundaries under anti-slop.** No function may take `unknown` (`no-unknown-parameters`), except a `cause` or the subject of a type predicate, and a `Record<string, unknown>` contract is rejected (`no-unsafe-dictionary-type`). Decode where the data enters instead: `const payload = PayloadSchema.parse(await response.json())` at the `fetch`/`JSON.parse` call site, then pass `z.infer<typeof PayloadSchema>` onward. A reusable check is a predicate, `function isPayload(value: unknown): value is Payload`. Every remaining `as` needs a `// SAFETY:` comment stating why it holds.
