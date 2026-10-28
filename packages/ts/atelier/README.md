# `@mistral/atelier` — vendored, not ours

Mistral Solutions' bespoke components built on `@mistralai/ui` (agent status, agent work
timelines, rosters, sparklines, swarm grids, reference cards…). Copied from the private repo
[`mistralai-solutions/atelier`](https://github.com/mistralai-solutions/atelier), directory
`packages/registry/` (published there as `@mistralai/atelier`), at commit
`9aad6c3018bcf1ddaf2ae8ed72fc39376647ae54` (`main`, vendored 2026-09-23).

Import from `@mistral/atelier` (everything `src/index.ts` exports) or from
`@mistral/atelier/components/<name>` for any component directory.

## What was left out

| Excluded                            | Why                                                                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/index.css`, `src/tokens/**`    | A byte-identical copy of the design-system tokens the app already loads from `@mistral/tailwind-config/web.css`; loading both would duplicate every `@theme`/`@utility`.                   |
| `*.stories.*`, `*.mdx`              | Storybook docs; need Storybook.                                                                                                                                                            |
| `*.perf.test.*`, `__screenshots__`  | vitest-browser perf/visual tests; need `@mistralai/atelier-perf` and a browser runner.                                                                                                     |
| `registry.json`, `public/`, configs | shadcn registry build and upstream tooling.                                                                                                                                                |

Upstream's `tokens.css` also carried the Tailwind `@source` scans for `src/components` and
`src/lib`; the app's stylesheet must `@source` this package's `src/` itself, or its classes are
not generated.

## Edits to upstream source

The test rename below and three type guards; the rest of `src/` is a verbatim copy.

- `src/components/disclosure/presence.unit.test.ts` → `presence.test.ts`, run by `bun test`:
  `import { describe, expect, it } from "vitest"` became
  `import { describe, expect, test } from "bun:test"` and each `it(` became `test(`.

No edit was needed for `@mistralai/ui` 86: upstream pins 53.1.0, but every subpath it imports
(`badge`, `face-avatar`, `file-icon`, `flex`, `loader`, `typography`, `utils`) still exists in 86
and `tsc` passes unchanged. Three guards make the source pass `noUncheckedIndexedAccess`, which
`apps/web` type-checks it with (upstream leaves it off): `values[index] ?? Number.NaN` in `sparkline.tsx`'s point loop,
`values[0] ?? 0` / `values.at(-1) ?? 0` in its `deriveLabel`, and a `!` on the modulo index in
`lib/hues.ts`'s `hueFromKey`. Reapply them after a re-sync.

## Re-syncing

1. Take `packages/registry/src/` from the new `main` commit
   (`gh api repos/mistralai-solutions/atelier/tarball/<sha>`), minus the exclusions above.
2. Reapply the test rename and the three type guards above; drop any new `*.unit.test.*` that needs a DOM.
3. Add a `package.json` `exports` subpath for each new component directory and re-check upstream's
   `dependencies`/`peerDependencies` for new bare imports.
4. Update the SHA here and in `package.json`, then type-check against the installed
   `@mistralai/ui` and run `bun test`.
