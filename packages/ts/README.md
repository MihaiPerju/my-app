# `packages/ts/@mistral/*` — vendored, not ours

Seven packages, none written here, all shipped by the **`mistral-design-system`** capability
because every one of them exists for `@mistralai/ui` or sits beside it. An app generated without
`mistral-design-system` ships none of them.

| Package                                     | What it is                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `common`, `i18n`, `markdown`, `next-hotkey` | The unpublished packages `@mistralai/ui` depends on, copied out of its monorepo. `markdown` is also imported directly by `apps/web`. |
| `tailwind-config`                           | The design system's theme, from the `@mistralai/ui` tarball's `tailwind/`. `apps/web` loads its whole style from `web.css`.          |
| `tsconfig`                                  | The TypeScript base the other four `extends`.                                                                                        |
| `atelier`                                   | Mistral Solutions' reusable React components (`mistralai-solutions/atelier`), built on `@mistralai/ui`. See its own README.          |

`mistral-design-system/` beside them is first-party: a dependency-only member,
`@app/mistral-design-system`, that pins `@mistralai/ui` and the `@mistral/*` members `apps/web`
imports, so `apps/web/package.json` carries no selection-dependent entries.

## Re-syncing

Copy the first four from the **`@mistralai/ui` tarball's own bundled `node_modules/@mistral/*`**,
never from the upstream monorepo's HEAD — a copy taken from HEAD can skew against the release
actually installed here. `tailwind-config` comes from the same tarball's `tailwind/` directory;
keep the deletions its `web.css` header lists.

## Why they are wired the way they are

Each fact below is load-bearing; changing one of these breaks `bun install` for some composition.

- **Directory names drop the `@mistral/` scope** their `package.json` still declares. bun matches
  workspace members by the `name` field, not by path.
- **They are workspace members, not `file:` targets.** bun discards the dependency object of a
  `file:` package reached through `overrides`, which left them installed with zero dependencies.
- **The root `overrides` block stays in the root `package.json`**, even though these moved to
  `mistral-design-system`. It repoints `@mistralai/ui`'s own dependency edges at the four. That manifest is
  core-owned, and an override naming an absent member is inert — bun resolves it only when
  something in the tree actually depends on that package, which needs `@mistralai/ui`, which needs
  `mistral-design-system`.
- **Nothing in the root `package.json` may `devDepend` on one of these.** Unlike an override, a
  `workspace:*` devDependency naming a missing member is a hard `failed to resolve`, so it would
  break every web-free app. `@mistral/tsconfig` used to be one and no longer is; the four packages
  that `extends` it declare it themselves instead.
- **Keep them off dot-prefixed paths.** bun's workspace globbing skips dot-directories, so a glob
  under one silently matches nothing and every member would have to be listed by hand.
- **The vendored/first-party split lives in the ignore lists,** `.oxlintrc.json` and
  `.oxfmtrc.json`, which name these seven directories one by one — never `packages/ts/**`, so a
  first-party sibling like `mistralai-capabilities` is still linted and formatted. Both stay
  owned by `code-quality` and keep working when `mistral-design-system` is deselected, because a pattern matching nothing is not
  an error. Exclude a newly vendored package by adding it to both.
