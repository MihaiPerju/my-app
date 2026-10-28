import { resolve } from "node:path";

import type { NitroModule } from "nitro/types";
import { normalizePath, type Plugin } from "vite";

/**
 * The shell's base stylesheet, relative to the web app root, and the design-system stylesheet as
 * that file imports it. The import has to land in the base stylesheet itself: its `@theme` and
 * `@source` declarations only reach the one Tailwind compilation that `@import "tailwindcss"` starts.
 */
const BASE_STYLESHEET = "src/index.css";
const DESIGN_SYSTEM_IMPORT = '@import "./styles/mistral-design-system.css";';
const TAILWIND_IMPORT = /@import\s+["']tailwindcss["'][^;]*;/;

/**
 * Everything the design-system stack needs from this app's Vite build, in one plugin that the
 * shell's `vite.config.ts` loads from `vite-plugins/` like every contributed plugin.
 * `@mistralai/ui` needs the SSR, deps and dedupe settings; the Shiki and tslib ones come from
 * libraries in its dependency tree (nothing in `@mistralai/ui` imports tslib itself), which a plain
 * TanStack Start app does not install. Each setting is pinned by a test in `src/`.
 */
const mistralDesignSystem: Plugin & { nitro: NitroModule } = {
  name: "mistral-design-system",
  // Adds the design-system stylesheet to the shell's base stylesheet, right after its Tailwind
  // import. `order: "pre"` runs this before Tailwind's own transform compiles the file. Only the
  // stylesheet's own source carries that import: the `?url` module that points at it is JavaScript
  // and is left alone.
  transform: {
    order: "pre",
    handler(code, id) {
      const baseStylesheet = normalizePath(resolve(this.environment.config.root, BASE_STYLESHEET));
      if (id.split("?", 1)[0] !== baseStylesheet || code.includes(DESIGN_SYSTEM_IMPORT))
        return null;
      const tailwind = TAILWIND_IMPORT.exec(code);
      if (!tailwind) return null;
      const end = tailwind.index + tailwind[0].length;
      return `${code.slice(0, end)}\n${DESIGN_SYSTEM_IMPORT}${code.slice(end)}`;
    },
  },
  config: () => ({
    ssr: {
      noExternal: ["@mistralai/ui", "@phosphor-icons/react", /@radix-ui\//],
    },
    optimizeDeps: {
      // Do not add `@mistralai/ui`'s transitive CJS packages (lodash.debounce, deepmerge, devicon,
      // common-path-prefix) here. Bun keeps them in its content-addressed store rather than
      // hoisting them, so Vite cannot resolve them and answers "Failed to resolve dependency:
      // <name>". The remedy is to not import the `@mistralai/ui` subpaths that reach them; the
      // test `src/mistralai-ui-cjs.test.ts` keeps that true.
      include: ["@mistralai/ui", "@phosphor-icons/react", "@tanstack/react-query", "sonner"],
    },
    resolve: {
      // Stateful per copy, so there must be one. `@mistralai/ui` ships TS source, so its own
      // `import ... from "framer-motion"` is resolved by this app, and bun can keep a second
      // version nested under it: two rAF frameloops and two `MotionConfig`/`LayoutGroup`
      // contexts. `src/framer-motion-single-copy.test.ts` fails if a second copy reappears.
      dedupe: ["react", "react-dom", "framer-motion"],
      alias: [
        // Shiki's `unwasm` export condition points `shiki/wasm` at the raw `onig.wasm`. Rolldown
        // selects that condition in the Linux production image, then tries to resolve the Wasm
        // module's `env` import as JavaScript and aborts the SSR build. The default export is
        // Shiki's inlined JavaScript wrapper around the same binary.
        { find: "shiki/wasm", replacement: "shiki/dist/wasm.mjs" },
        // Force tslib's ESM build: its UMD/CJS entry breaks the Nitro SSR bundle
        // (`Cannot destructure property '__extends' of __toESM(...).default`).
        { find: "tslib", replacement: "tslib/tslib.es6.mjs" },
      ],
    },
  }),
  // Nitro collects a `nitro` module from every Vite plugin. It never bundles tslib: it
  // externalizes the bare `tslib` import and traces only the file the alias above resolved,
  // `tslib.es6.mjs`. At runtime Node resolves `tslib` to `modules/index.js`, which was not copied,
  // and the server fails with ERR_MODULE_NOT_FOUND. `*` copies the whole (small) package.
  nitro: {
    setup: (nitro) => {
      (nitro.options.traceDeps ??= []).push("tslib*");
    },
  },
};

export default mistralDesignSystem;
