---
name: capability-github-automation
description: The generated repo's GitHub automation as one concern — the closure-gated `ci.yml` workflow, the `uv-workspace` composite action, the Solutions security gate, and `renovate.json`. Use when editing CI or adding a job, when a job must gate on a capability being installed, when the private-index auth breaks a CI install, or when tuning Renovate's grouping and toolchain-lockstep rules.
---

# GitHub automation

Owns the generated repo's GitHub-side automation — CI, the Solutions security gate, and dependency updates — as four files under `.github/` plus `renovate.json`. Owns **no commands of its own**: CI jobs run nx targets defined by `code-quality`, `testing`, and the feature/runtime capabilities; deployment CI belongs to `helm` (its own `helm.yml`).

## Where things live

| Path | What |
| --- | --- |
| `.github/workflows/ci.yml` | Rendered from the `ci.yml.hbs` carrier: 3 always-on Python jobs + 4 closure-gated jobs. |
| `.github/actions/uv-workspace/action.yml` | Composite action every Python job calls: installs uv+bun, auths the private Mistral index, `uv sync`. |
| `.github/workflows/solutions-security-gate.yml` | `mistralai-solutions/sol-security` pre-commit gate; runs every PR (`fetch-depth: 0`), no closure gating. |
| `renovate.json` | Grouping rules, private-index handling, and the custom manager that keeps split toolchain pins in lockstep. |

Always-on jobs: **py-lint** (`quality:lint`+`quality:fmt-check`), **py-typecheck** (`quality:typecheck`), **py-test** (`testing:test`). Gated jobs: `agent-checks` (`agents`), `ts-checks`/`gen-types-drift` (`tanstack-start`), `pg-contract` (`postgres`), `e2e` (`docker-compose`).

## Add a CI job

Seam: a rendered workflow may reference only commands/assets the selection generated. A job running a capability's nx target belongs inside that capability's `{{#if (has "<cap>")}}…{{/if}}` block, stated positively.

1. Add the job to `ci.yml.hbs`; wrap it in `{{#if (has "<cap>")}}` if it runs a gated capability's target.
2. Escape GitHub expressions — write `${{ … }}` as `$\{{ … }}` (Handlebars owns `{{ }}`; only `{{#if (has …)}}` are real directives).
3. Python jobs call `./.github/actions/uv-workspace` for private-index auth — don't copy the setup; bun-only/toolchain-free jobs set bun+`.npmrc` up inline.
4. If the job feeds `e2e`, add it to `e2e`'s inline-gated `needs:` list so it never waits on an unrendered job.
5. Pinning a new toolchain input: add a `# renovate: datasource=… depName=…` comment above the `with:` value so Renovate's custom manager tracks it.

## Gotchas

- Auth uses `UV_INDEX_<NAME>_USERNAME/PASSWORD`, **not** `UV_EXTRA_INDEX_URL` (which re-registers the private host and undoes dependency-confusion hardening). The `MISTRAL_REGISTRY_TOKEN` secret fans into `UV_INDEX_MISTRALAI_PASSWORD` + `NODE_AUTH_TOKEN`.
- Renovate disables `@mistralai/*`, `@mistral/*`, `mistralai*`, and vendored `packages/ts/*` (can't reach private indexes) — bump by hand (`bun update`, `bun run lock`). Toolchain grouping rules must sit **after** `container base images` (last-match-wins).
