# Install — `@mistralai-capabilities/testing`

Adds the app's test infrastructure: Pytest configuration and bootstrap, the coverage ratchet, the
generated-workspace contract tests, and the `testing` project's `test`, `test-cov`, `test-web-cov`,
and `check` targets.

## Prerequisites

- Sibling capabilities: `core`.
- Toolchain: uv; Bun for `test-web-cov`, which runs only when `apps/web` exists (`tanstack-start`).

## Install

```bash
mistral apps capability add testing
bun run install-all   # syncs the pytest/coverage dependencies
```

Verify with `bunx nx run testing:test` and `bunx nx run testing:test-cov`.
