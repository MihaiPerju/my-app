# Install — `@mistralai-capabilities/feature-mistral-design-system`

Adds the Mistral look to `apps/web`: `@mistralai/ui` with its theme and fonts, the sidebar app shell
(`apps/web/src/routes/_app.tsx`), shared page components, and the vendored `@mistral/*` workspace
packages under `packages/ts/`.

## Prerequisites

- Sibling capabilities: `core` and `tanstack-start`.
- Private npm registry access: `@mistralai/ui` is not on public npm (the vendored `@mistral/*`
  packages are workspace-local). Provide the registry pull token as `MISTRAL_REGISTRY_TOKEN`, which
  `bun run install-all` passes to bun as `NODE_AUTH_TOKEN`; in a fresh clone, copy `.npmrc.example`
  to `.npmrc` first. Never commit `.npmrc`.

## Install

```bash
mistral apps capability add mistral-design-system
bun run install-all   # sync the new dependencies
```

Verify with `bunx nx run web:build` and `bunx nx run web:test`.
