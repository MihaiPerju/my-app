/**
 * A tripwire on the theme: every `var(--token)` this app renders must be a token something defines.
 * The theme is vendored and re-synced by hand; an undefined custom property is not an error, so a
 * dropped token leaves the build green while a surface loses colour. Only direct `var()` references are checked.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

import { capabilityLibraryRoots } from "./test/capability-roots";

const WEB_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(WEB_ROOT, "..", "..");

/** Where a token may be DEFINED: the vendored theme, and this app's own stylesheets on top of it. */
const DEFINING = [
  join(REPO_ROOT, "packages", "ts", "tailwind-config"),
  join(WEB_ROOT, "src", "styles"),
];

/** Our own code, where a `var()` is always a reach for a theme token. */
const REFERENCING = [
  join(WEB_ROOT, "src"),
  join(REPO_ROOT, "packages", "ts", "mistralai-capabilities"),
  ...capabilityLibraryRoots(REPO_ROOT),
].filter((directory) => existsSync(directory));

/**
 * `@mistralai/ui`'s shipped CSS is checked too, and it is the likeliest source of a reference the
 * vendored theme lacks. Only its stylesheets, not its `.tsx`: a `var()` in a DS component is
 * usually a custom property that component sets inline nearby, which the theme should not define.
 */
// Nested under the web app with bun's default linker, hoisted to the workspace root under
// `linker = "hoisted"` (what the capability registry's CLI writes into a generated app). Take the
// first that resolves rather than assuming either layout.
const REFERENCING_CSS_ONLY = [
  join(WEB_ROOT, "node_modules", "@mistralai", "ui", "src"),
  join(REPO_ROOT, "node_modules", "@mistralai", "ui", "src"),
]
  .filter((directory) => existsSync(directory))
  .slice(0, 1);

const READ = new Set([".css", ".ts", ".tsx"]);

/**
 * Set at runtime, never by the theme, so their absence is correct rather than a gap.
 * `--radix-*` is Radix reporting a measured size; the two colours are written inline by the DS
 * animated counter on the element that reads them, and `--text-hover-scroll-*` by the DS
 * `TextHoverScroll` on its own container.
 */
const RUNTIME_PREFIXES = [
  "--radix-",
  "--increment-color",
  "--decrement-color",
  "--text-hover-scroll-",
];

/**
 * Declared and read by one DS stylesheet on its own component, never by the theme:
 * `command-execution-ansi.css` defines the `--color-ansi-*` terminal palette under the command
 * output's selector. Listed by name rather than accepting every DS declaration, which would also
 * pass a token scoped to one component but referenced outside it.
 */
const DS_SCOPED_PREFIXES = ["--color-ansi-"];

/**
 * `@mistralai/ui/markdown.css` rounds markdown images with `var(--radius)`, and no Mistral theme
 * defines it — le-chat-web, which is the reference this theme was taken from, does not either.
 * An upstream quirk that predates the vendoring, reproduced faithfully rather than papered over.
 */
const KNOWN_UNDEFINED = new Set(["--radius"]);

function filesUnder(directory: string, extensions: Set<string> = READ): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".nx") continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...filesUnder(path, extensions));
    else if (extensions.has(extname(path)) && !/\.test\.tsx?$/.test(path)) found.push(path);
  }
  return found;
}

/** Comments hold example CSS — `hsl(var(--border))` in a note about a deleted block reads as a real
 * reference and would fail this for no reason. */
function withoutComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "");
}

function scan(
  roots: string[],
  pattern: RegExp,
  extensions: Set<string> = READ,
): Map<string, string> {
  const found = new Map<string, string>();
  for (const root of roots) {
    for (const file of filesUnder(root, extensions)) {
      const source = withoutComments(readFileSync(file, "utf8"));
      for (const [, token] of source.matchAll(pattern)) {
        if (token && !found.has(token)) found.set(token, file);
      }
    }
  }
  return found;
}

describe("theme tokens", () => {
  test("every referenced custom property is defined by the vendored theme", () => {
    const defined = new Set(scan(DEFINING, /(--[A-Za-z0-9_-]+)\s*:/g).keys());
    // Guard the guard: a wrong path would make `defined` tiny and the assertion vacuous.
    expect(defined.size).toBeGreaterThan(500);

    const referenced = new Map([
      ...scan(REFERENCING, /var\(\s*(--[A-Za-z0-9_-]+)/g),
      ...scan(REFERENCING_CSS_ONLY, /var\(\s*(--[A-Za-z0-9_-]+)/g, new Set([".css"])),
    ]);

    const unresolved = [...referenced]
      .filter(([token]) => !defined.has(token))
      .filter(([token]) => !KNOWN_UNDEFINED.has(token))
      .filter(([token]) => !RUNTIME_PREFIXES.some((prefix) => token.startsWith(prefix)))
      .filter(([token]) => !DS_SCOPED_PREFIXES.some((prefix) => token.startsWith(prefix)))
      .map(([token, file]) => `${token} (referenced by ${file})`);

    expect(unresolved).toEqual([]);
  });
});
