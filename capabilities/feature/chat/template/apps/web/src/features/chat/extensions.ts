import type { ChatExtension } from "./chat-api";

/**
 * Every chat extension installed in this app, merged. A capability extends chat by adding a module
 * under `./extensions/` whose default export is a `ChatExtension` — speech contributes dictation
 * and read-aloud this way. Two extensions providing the same member is a composition error, not a
 * silent last-one-wins.
 *
 * Only the chat route imports this module: `import.meta.glob` is Vite's, and bun's test runner has
 * no such thing, so tests hand `ChatApiProvider` their own extensions instead.
 */
const modules = import.meta.glob<{ default: ChatExtension }>(
  ["./extensions/*.ts", "!./extensions/*.test.ts"],
  { eager: true },
);

export const chatApiExtensions: ChatExtension = mergeExtensions(modules);

function mergeExtensions(found: Record<string, { default: ChatExtension }>): ChatExtension {
  const merged: ChatExtension = {};
  const providers = new Map<string, string>();
  for (const path of Object.keys(found).toSorted()) {
    const extension = found[path]?.default ?? {};
    for (const member of Object.keys(extension)) {
      const previous = providers.get(member);
      if (previous) {
        throw new Error(`Chat extensions ${previous} and ${path} both provide \`${member}\`.`);
      }
      providers.set(member, path);
    }
    Object.assign(merged, extension);
  }
  return merged;
}
