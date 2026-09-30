---
name: capability-mistral-design-system
description: The Mistral look for `apps/web` — `@mistralai/ui` with its vendored theme and fonts, the sidebar app shell as the pathless `_app` layout route whose nav comes from each route's `staticData`, the shared page components, and the vendored atelier components. Use when adding a page to the sidebar, building UI from Mistral components, changing the theme, sidebar or brand, or when `@mistralai/ui` breaks the Vite/SSR build.
---

# Mistral Design System

Layers the Mistral design system onto the plain TanStack Start app from `capability-tanstack-start`.
Everything is opt-in by route: a page wears the shell by living under `apps/web/src/routes/_app/`.

## Where things live

| Path | What |
| --- | --- |
| `apps/web/src/routes/_app.tsx` | Pathless layout: theme + tooltip + toaster providers and the `AppShell`. `?embed` renders the page bare. |
| `apps/web/src/routes/_app/$.tsx` | Not-found page for any URL no page claims, inside the shell (loader throws `notFound()`, so the server answers 404; the page is its `notFoundComponent`); no `nav` entry. Also keeps `_app` non-empty (a childless pathless layout collides with `/`), so an app with no feature page still builds — keep it. |
| `apps/web/src/shell/nav.ts` | The `staticData.nav` / `staticData.sidebar` types and `navFromRoutes`. |
| `apps/web/src/shell/app-shell.tsx` | The sidebar: brand (links to the landing page), primary actions, nav groups, sidebar sections, theme toggle. |
| `apps/web/src/shell/{theme,sidebar-state}.ts` | Cookie-backed theme (class on `<html>` via a head script) and sidebar state. |
| `apps/web/src/styles/mistral-design-system.css` | Injected into the shell's `src/index.css` by the Vite plugin below (after `@import "tailwindcss"`): theme, `@mistralai/ui/markdown.css`, the Tailwind `@source` scans. |
| `apps/web/vite-plugins/mistral-design-system.ts` | The Vite plugin (default export, loaded by the shell's `vite.config.ts`): what `@mistralai/ui` needs (SSR `noExternal`, `optimizeDeps`, dedupe, aliases, Nitro tslib trace) and the `transform` that adds the stylesheet import to `src/index.css`. |
| `@mistralai-capabilities/feature-mistral-design-system` | `./components` (`ProductPage`/`ProductSection`, states, form controls, `JsonInspector`) and `./lib` (`formatMessageDate`). |
| `packages/ts/atelier/` | `@mistral/atelier`: vendored `mistralai-solutions/atelier` components (agent work, sparkline, swarm grid, …). |
| `packages/ts/{common,i18n,markdown,next-hotkey,tailwind-config,tsconfig}/` | Vendored `@mistral/*` packages `@mistralai/ui` depends on; see `packages/ts/README.md`. |

## Add a page to the sidebar

```tsx
// apps/web/src/routes/_app/reports.tsx → /reports
export const Route = createFileRoute("/_app/reports")({
  staticData: { nav: { label: "Reports", icon: ChartBarIcon, group: "Apps" } },
  component: ReportsPage,
});
```

- `nav.group` is the heading; rows without one share an unlabelled group. `nav.primary: true` pins a
  "new X" action above all groups (links with search cleared). `staticData.sidebar` renders a
  component in the expanded sidebar (e.g. recent items). Order is by route id.
- Import DS primitives from their `@mistralai/ui/<name>` subpath, never the root barrel; a new
  subpath must be added to `ALLOWED` in `src/mistralai-ui-cjs.test.ts`.

## Gotchas

- Every setting in `vite-plugins/mistral-design-system.ts` and the `@source` lines is pinned by a test in
  `apps/web/src/`; read it before editing.
- Do not import `mistral-design-system.css` from a route or from `src/index.css`: it declares
  `@theme` and `@source`, which only work inside the Tailwind compilation `src/index.css` starts,
  and the plugin already adds it there.
- `@mistralai/ui` is private: this capability ships `.npmrc` (from `.npmrc.example`), the only file
  mapping the `@mistralai`/`@mistral` scopes; installs need the index token, and the web image build
  the `registry_token` secret. `packages/ts/mistral-design-system/package.json` ships as `.hbs` so the
  CLI writes it after its first install, together with `.npmrc`.
- The dependency-only `packages/ts/mistral-design-system` member pins what the shell imports:
  `@mistralai/ui`, the public `@phosphor-icons/react`, `framer-motion`, `sonner` and
  `tw-animate-css`, and the `@mistral/atelier`, `@mistral/markdown` and `@mistral/tailwind-config`
  members. They are hoisted to the root `node_modules`; `apps/web/package.json` does not list them.
  Bump them there.
