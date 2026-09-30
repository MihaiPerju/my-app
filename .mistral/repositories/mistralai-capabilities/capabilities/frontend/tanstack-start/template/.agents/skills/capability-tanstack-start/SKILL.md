---
name: capability-tanstack-start
description: The app's frontend — a plain TanStack Start (Vite + Nitro SSR) app at `apps/web` with file-based routes, TanStack Query in router context and Tailwind, on public packages only. Use when adding a page or route, choosing the landing page, wiring data loading, or when the Vite/Nitro SSR build or the web image breaks. For the Mistral look and sidebar see `capability-mistral-design-system`; for the typed API client see `capability-fastapi-tanstack-start`.
---

# TanStack Start

`apps/web` is a stock TanStack Start app: `tanstackStart()` + `nitro()` + React + Tailwind v4,
file-based routing, and a `QueryClient` per request in router context. It depends only on public npm
packages. It owns no layout, no design system and no API client: those arrive with
`mistral-design-system` and the hidden `fastapi-tanstack-start`, which plug in by adding files (a
Vite plugin in `apps/web/vite-plugins/`, route files, an Nx project of their own). The template has
no `.hbs` file and names no other capability.
`apps/web/package.json` is plain JSON: a capability whose web code needs a package ships it in a
dependency-only `packages/ts/<capability>/package.json` member instead, which the hoisted linker
lifts to the root `node_modules`.

## Where things live

| Path | What |
| --- | --- |
| `apps/web/src/routes/` | File routes. `__root.tsx` is the HTML document (`shellComponent`) and head; `index.tsx` is `/`. `routeTree.gen.ts` is generated. |
| `apps/web/src/router.tsx` | `getRouter()`: the `QueryClient` (via `Wrap`) and the router context (`queryClient`, `landingPath`). |
| `apps/web/src/landing.ts` | `staticData.landing`: the route `/` redirects to. |
| `apps/web/src/app-name.ts` | `useAppName()`: the server's runtime `APP_NAME`, else the build-time one `vite.config.ts` reads from the root `.env`, else `App`; carried to the browser in router context (`router.tsx` `dehydrate`/`hydrate`). |
| `apps/web/vite.config.ts` | Stock config plus every plugin in `apps/web/vite-plugins/` (default export, filename order). |
| `deploy/docker/Dockerfile.web` | Web image: Nitro `runtime` (`node .output/server/index.mjs`, uid 1000, `:3001`) + `dev` HMR stage. Takes the `APP_NAME` build arg. |

## Add a page

- Add `apps/web/src/routes/<path>.tsx` with `createFileRoute`. For a page inside a layout, put it in
  that layout's pathless directory (`routes/_app/<path>.tsx` for the Mistral shell); the `_app`
  segment is not part of the URL.
- Load data with `loader` + `context.queryClient.ensureQueryData(...)`, read it with
  `useSuspenseQuery`. Validate search params with `validateSearch` (zod v4 schemas work directly).
- Declare route metadata in `staticData`: `landing` claims the landing page, and `/` redirects to
  the strongest claim (`true` is rank 0, a number is that rank, ties go to the route id sorting
  first; chat claims `10`); `mistral-design-system` adds `nav` and `sidebar`.
- Code that is not a route but sits next to one goes in a `-`-prefixed file or folder (`-components/`),
  which the router ignores, or under `src/features/<id>/`.

## Web composition

Every capability adds to `apps/web` by adding files, through the frameworks' own extension points;
none edits another's file.

| To add | Add this file | Discovered by |
| --- | --- | --- |
| A page | `src/routes/<path>.tsx` (`routes/_app/<path>.tsx` inside the design-system shell) | TanStack Router file routes |
| Page metadata | `staticData`: `landing`; with the design system, `nav` and `sidebar` | the route tree |
| A Vite / Nitro build concern | `vite-plugins/<name>.ts`, default-exporting a Vite `Plugin` (`config()` to change settings) | `vite.config.ts`, filename order |
| A chat side app (with `chat`) | `src/routes/_app/chat/<app>.tsx` with `staticData.chatApp: { label, icon, tools?, fullscreen? }`; `useChatContext()` for the conversation | chat's layout route |
| A chat API extension (with `chat`) | `src/features/chat/extensions/<name>.ts`, default-exporting a `ChatExtension` (`transcribeAudio?`, `synthesizeSpeech?`) | `features/chat/extensions.ts` (Vite `import.meta.glob`) |

## Gotchas

- `vite.config.ts` reads `vite-plugins/` once, at startup: after adding or editing a plugin file,
  restart `bun run dev`.

- `@tanstack/*` direct deps are exact pins that must match core's `overrides`; bump them together.
- `__root.tsx` sets `suppressHydrationWarning` on `<html>` because layout routes may add a class
  there from a head script before hydration (the design system's theme does).
- `bun run dev` serves `:3001`. Behind the gateway the session cookie comes from it.
