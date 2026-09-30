/**
 * A tripwire on which `@mistralai/ui` subpaths this app imports. The package ships raw TypeScript,
 * so Vite serves a non-bundled subpath as raw source; its import reaches the browser with no
 * `default` export and the page never hydrates. Add a new subpath to `optimizeDeps.include` if it breaks.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { capabilityLibraryRoots } from "./test/capability-roots";

const WEB_ROOT = resolve(import.meta.dir, "..");
const APP_ROOT = resolve(WEB_ROOT, "../..");

// The shared components moved into the capability library, and they are the heaviest users of
// these subpaths — crawling only `apps/web/src` would leave the tripwire pointing at the half of
// the graph that no longer imports them.
const CRAWLED = [
  join(WEB_ROOT, "src"),
  join(APP_ROOT, "packages", "ts", "mistralai-capabilities"),
  ...capabilityLibraryRoots(APP_ROOT),
].filter((directory) => existsSync(directory));
const UI_PACKAGE = "@mistralai/ui";
const BARE_IMPORT = /from\s+["']([^"'.#][^"']*)["']/g;

/**
 * Entries verified working in a browser. `@mistralai/ui/sidebar` is absent because it is broken.
 * The root barrel is absent because it is wasteful: it does not tree-shake, so it pulled
 * `react-day-picker`, `date-fns`, `vaul` and other deps into the `chat` chunk. Reach for a subpath
 * or vendor the component instead.
 */
const ALLOWED = new Set([
  "@mistralai/ui/app-shell",
  "@mistralai/ui/autosize-textarea",
  "@mistralai/ui/badge",
  "@mistralai/ui/branding",
  "@mistralai/ui/button",
  "@mistralai/ui/charts",
  "@mistralai/ui/chat-thread",
  "@mistralai/ui/collapsible",
  "@mistralai/ui/divider",
  "@mistralai/ui/dropdown-menu",
  "@mistralai/ui/flex",
  "@mistralai/ui/grid",
  "@mistralai/ui/inline-tip",
  "@mistralai/ui/input",
  "@mistralai/ui/loader",
  "@mistralai/ui/markdown",
  "@mistralai/ui/markdown.css",
  "@mistralai/ui/resizable",
  "@mistralai/ui/table",
  "@mistralai/ui/tabs",
  "@mistralai/ui/task-loader",
  "@mistralai/ui/tooltip",
  "@mistralai/ui/typography",
  "@mistralai/ui/utils",
]);

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules") continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path)) {
      found.push(path);
    }
  }
  return found;
}

function crawledSourceFiles(): string[] {
  return CRAWLED.flatMap((directory) => sourceFiles(directory));
}

describe("@mistralai/ui subpath imports", () => {
  test("no unvetted subpath is imported, because an unbundled one stops the page hydrating", () => {
    const imported = new Set<string>();
    for (const file of crawledSourceFiles()) {
      for (const [, specifier] of readFileSync(file, "utf8").matchAll(BARE_IMPORT)) {
        if (specifier?.startsWith(UI_PACKAGE)) imported.add(specifier);
      }
    }
    // A crawl that found nothing would pass while asserting nothing.
    expect(imported.size).toBeGreaterThan(5);

    expect([...imported].filter((name) => !ALLOWED.has(name)).toSorted()).toEqual([]);
  });

  test("the root barrel is not imported, because it does not tree-shake", () => {
    const importers: string[] = [];
    for (const file of crawledSourceFiles()) {
      for (const [, specifier] of readFileSync(file, "utf8").matchAll(BARE_IMPORT)) {
        if (specifier === UI_PACKAGE) importers.push(file.slice(WEB_ROOT.length + 1));
      }
    }
    expect(importers.toSorted()).toEqual([]);
  });
});
