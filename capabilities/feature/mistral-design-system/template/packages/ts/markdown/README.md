# @mistral/markdown

`@mistral/markdown` parses markdown into mdast-compatible ASTs.

The package is optimized for LLM messages:

- one-shot parsing for complete messages
- append-aware sessions for streaming messages
- optimistic projection for unfinished input

The package does not render HTML and does not export React components.

An experimental React hook is available from `@mistral/markdown/react`.

## Syntax

The parser has one dialect. There are no runtime syntax modes.

Supported syntax:

- CommonMark, parsed through the package dialect rather than a pure CommonMark mode
- GitHub Flavored Markdown: autolink literals, strikethrough, tables, task list items, footnotes
- inline math: `$...$`, `\(...\)`
- block math: `$$...$$`, `\[...\]`
- inline HTML and HTML blocks
- custom elements written as HTML

Unsupported syntax:

- markdown directives
- MDX
- bare TeX environments as markdown delimiters, such as standalone `\begin{align}...\end{align}`

TeX environments are valid math payload when they appear inside a supported math delimiter.

Directive-backed product syntax should be migrated to custom elements or plain HTML. Product adapters can then decode parsed `html` nodes into product-owned AST nodes.

## Public API

```ts
import type { Nodes, Root } from "mdast";

export type MarkdownNodeFlags = {
  readonly unfinished?: true;
  readonly optimistic?: true;
};

export type MarkdownDiagnostic = {
  readonly code: "not-implemented" | "unfinished-input";
  readonly message: string;
  readonly offset: number;
};

export type MarkdownSnapshot = {
  readonly ast: Root;
  readonly diagnostics: readonly MarkdownDiagnostic[];
  readonly finalized: boolean;
  readonly sourceLength: number;
};

export type MarkdownSession = {
  parse(source: string, isDone?: boolean): MarkdownSnapshot;
};

export type UnstableMarkdownTransform = {
  readonly parentTypes: readonly string[];
  readonly transform: (children: readonly Nodes[]) => readonly Nodes[];
};

export type MarkdownOptions = {
  readonly unstable_transforms?: readonly UnstableMarkdownTransform[];
};

export function parseMarkdown(
  source: string,
  options?: MarkdownOptions,
): MarkdownSnapshot;

export function createMarkdownSession(
  options?: MarkdownOptions,
): MarkdownSession;
```

`sourceLength` is measured in JavaScript string length: UTF-16 code units.

Snapshots and ASTs are a read-only contract. The package preserves object identity for unchanged subtrees, but it does not freeze returned objects. Consumers must not mutate snapshots.

## `parseMarkdown(source)`

Parses a complete markdown string and returns a finalized snapshot.

Use this for non-streaming content.

```ts
import { parseMarkdown } from "@mistral/markdown";

const snapshot = parseMarkdown("# Hello");

console.log(snapshot.finalized); // true
console.log(snapshot.ast.type); // "root"
```

## React Hook

`@mistral/markdown/react` exports `useMistralMarkdown(source, options?)`.

```tsx
import { useMistralMarkdown } from "@mistral/markdown/react";

const snapshot = useMistralMarkdown(markdown, {
  isDone,
  smooth: true,
  unstable_transforms: transforms,
});
```

Initial snapshots publish the current source immediately. `smooth` is dynamic and applies to later connected updates. Switching it off publishes the latest full source immediately. `isDone: true` also bypasses smoothing and publishes the latest full source.

Smoothing only animates connected updates. If React disconnects the hook's effects and subscriptions, such as under a hidden Activity tree, the next connected update catches up to the latest source immediately and later connected updates keep streaming from there.

`unstable_transforms` are captured when the hook is created. This makes inline transform arrays safe for React consumers; remount the component if the transform set itself must change.

## `createMarkdownSession()`

Creates a stateful parser session.

Call `parse(source, isDone?)` with the latest accumulated source string. The session detects whether the new source extends the previous source:

- if it extends the previous unfinished source, the session reuses append-only parser state
- otherwise, the session resets and reparses
- `parse(source, true)` finalizes the current source
- after finalization, the next unfinished parse starts a new session workspace

The session owns mutable parser state. It is single-writer and not concurrent-safe. Returned snapshots stay detached from that workspace by contract.

```ts
import { createMarkdownSession } from "@mistral/markdown";

const session = createMarkdownSession();

session.parse("# Hel");
session.parse("# Hello\n\n");
const snapshot = session.parse("# Hello\n\nWorld", true);

console.log(snapshot.finalized); // true
```

## Optimistic projection

Optimistic projection exists to keep streaming markdown visually stable. Its goal is to avoid flashes where raw markdown syntax appears briefly and then turns into formatted content. It is not a throughput optimization and it should not publish a node earlier just because it can.

Unfinished streaming input may produce temporary AST nodes. These nodes are marked under `node.data.mistralMarkdown`.

```ts
type MarkdownNodeFlags = {
  readonly unfinished?: true;
  readonly optimistic?: true;
};
```

`unfinished` means the node depends on input that may still change.

`optimistic` means the parser temporarily projected an open construct because the formatting intent is already clear. For example, explicit link destinations such as `[docs](https://exa` can stay link-shaped while waiting for `)`, because rendering them as plain text first would cause a style flash. Ambiguous tails should be suppressed until there is enough signal or finalization resolves them.

Finalized incremental output must match `parseMarkdown(source)` for the same source.

## `unstable_transforms`

`unstable_transforms` are AST projection hooks. They are not parser plugins and they cannot add markdown syntax.

Use them for product-owned projection, such as replacing parsed `html` nodes with app-specific nodes before publication.

Rules:

- transforms run after markdown parsing and before snapshot publication
- `parentTypes` selects parent node types whose child arrays are passed to the transform
- return the same child array when unchanged
- return a different child array to replace that parent’s children
- transforms must be synchronous and deterministic
- transformed nodes are not fed back into parser state

Transforms run on every published streaming snapshot. Benchmark product transforms against real messages before relying on them in hot paths.

Generic transforms are available from deep exports.
`llmCompatibilityTransforms` normalizes bare literal HTML `<br>` leaves to
Markdown break nodes in supported inline parents, including headings and table
cells. It also reprojects simple one-item ordered lists as paragraphs while it
preserves the list number.
`liftSpecialUriLinks` supports Mistral generalized-reference placement links
such as `[Chart](component://...)` by lifting consumer-selected block links out
of paragraphs before rendering.

```ts
import {
  liftSpecialUriLinks,
  llmCompatibilityTransforms,
} from "@mistral/markdown/transforms";

const session = createMarkdownSession({
  unstable_transforms: [
    ...llmCompatibilityTransforms,
    liftSpecialUriLinks(isRegisteredSpecialUri),
  ],
});
```

`sanitizeMarkdownUrl` is available from `@mistral/markdown/url` for renderers.
It preserves safe standard markdown URLs by default and accepts an optional
predicate for registered product URLs such as generalized-reference placement
links.

```ts
import { sanitizeMarkdownUrl } from "@mistral/markdown/url";

const href = sanitizeMarkdownUrl(node.url, isRegisteredSpecialUri);
```

```ts
import type { Nodes } from "mdast";

import {
  createMarkdownSession,
  type UnstableMarkdownTransform,
} from "@mistral/markdown";

const decodeCustomElements = {
  parentTypes: ["root", "paragraph"],
  transform(children) {
    let next: Nodes[] | undefined;

    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      const replacement =
        child?.type === "html" && child.value === "<custom-element />"
          ? ({ type: "custom-element" } as unknown as Nodes)
          : child;

      if (replacement === child && next === undefined) continue;

      next ??= children.slice(0, index);
      if (replacement !== undefined) next.push(replacement);
    }

    return next ?? children;
  },
} satisfies UnstableMarkdownTransform;

const session = createMarkdownSession({
  unstable_transforms: [decodeCustomElements],
});
```

## Testing and benchmarks

The test strategy is described in `docs/testing.md`.
The official CommonMark and GFM corpus files are committed under `tests/spec-harness/corpus/`, so both `test:ci` and the spec commands run without a local `.scratch` checkout.

Commands:

- `pnpm --filter @mistral/markdown test:ci`
- `pnpm --filter @mistral/markdown build`
- `pnpm --filter @mistral/markdown spec:commonmark`
- `pnpm --filter @mistral/markdown spec:gfm`
- `pnpm --filter @mistral/markdown spec:gfm-full`
- `pnpm --filter @mistral/markdown bench:node`
- `pnpm --filter @mistral/markdown bench:hermes`

Benchmark interpretation lives in `docs/perf-report.md`.
