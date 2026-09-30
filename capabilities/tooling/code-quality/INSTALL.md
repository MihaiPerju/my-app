# Install — `@mistralai-capabilities/code-quality`

Adds formatting, linting, type-checking, dependency auditing, shell/Dockerfile linting, pre-commit
hooks, and the `quality` project's `check` and `fix` targets. Each check applies only to the files
present in the app.

## Prerequisites

- Sibling capabilities: `core`.
- Toolchain: uv, Bun and `shellcheck` (every app ships shell scripts under `tools/`); Docker if it
  ships Dockerfiles (hadolint runs from its published image).

## Install

```bash
mistral apps capability add code-quality
bun run install-all   # syncs the tooling dependencies and installs the pre-commit hooks
```

Verify with `bunx nx run quality:check`.
