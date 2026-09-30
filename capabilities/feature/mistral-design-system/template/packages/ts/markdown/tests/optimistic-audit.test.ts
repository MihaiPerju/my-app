import type { Root, RootContent } from "mdast";
import { describe, expect, it } from "vitest";

import { createMarkdownSession } from "../src/index.ts";

const STREAMING_FIXTURE = `# Streaming answer

The parser should avoid raw delimiter flashes while the message is still arriving.

- **Parser core** keeps formatting stable.
- **Optimistic projection** hides ambiguous tails.

1. Feed the accumulated string.
2. Render stable snapshots.
3. **Keep references** link-shaped when intent is clear.
4. **Avoid syntax flashes** when intent is not clear.

| Capability | Status | Notes |
| :--- | :---: | :--- |
| Links | done | see [docs](https://docs.mistral.ai/guide) |
| Math | done | supports $a^2 + b^2 = c^2$ and \\( x^2 + y^2 = z^2 \\) |
| Tables | done | hides partial rows |

During streaming, users should not see **bold text** or dangling delimiters.

Use \`const session = createMarkdownSession()\` and finalize once the response is done.`;

const VARIABLE_CHUNK_SIZES = [2, 5, 1, 9, 3, 14, 4, 7, 18, 2, 11, 6] as const;

const MONOTONIC_STREAMING_CASES = [
  "Before **bold** after.",
  "Before __bold__ after.",
  "Before *emphasis* after.",
  "Before _emphasis_ after.",
  "Use `inline code` now.",
  "Use ``code with ` tick`` now.",
  "Visit [docs](https://docs.mistral.ai), then continue.",
  "Visit [docs](<https://docs.mistral.ai>), then continue.",
  "Image ![alt](https://docs.mistral.ai/image.png), then continue.",
  "Math \\( E = mc^2 \\) then continue.",
  "Math $a^2 + b^2$ then continue.",
  "Angle <https://docs.mistral.ai> then continue.",
  "List:\n- item\n- second\nDone.",
  "Break:\n---\nAfter.",
  "Heading\n---\nAfter.",
  "Table:\n\n| A | B |\n| - | - |\n| x | y |\nAfter.",
] as const;

function renderVisibleText(root: Root): string {
  let text = "";
  const stack: RootContent[] = [...root.children].reverse();

  while (stack.length > 0) {
    const node = stack.pop();

    if (node === undefined) {
      continue;
    }

    if (
      node.type === "text" ||
      node.type === "inlineCode" ||
      node.type === "code" ||
      node.type === "html"
    ) {
      text += node.value;
      continue;
    }

    if (node.type === "inlineMath" || node.type === "math") {
      text += node.value;
      continue;
    }

    if (node.type === "break") {
      text += "\n";
      continue;
    }

    if (node.type === "image") {
      text += node.alt ?? "";
      continue;
    }

    if ("children" in node) {
      stack.push(...[...node.children].reverse());
    }
  }

  return text;
}

function expectMonotonicVisibleTextAcrossEveryCut(source: string): void {
  const session = createMarkdownSession();
  const finalVisibleText = renderVisibleText(
    createMarkdownSession().parse(source, true).ast,
  );
  let previousVisibleText = "";

  for (let prefixLength = 1; prefixLength <= source.length; prefixLength += 1) {
    const prefix = source.slice(0, prefixLength);
    const visibleText = renderVisibleText(session.parse(prefix, false).ast);
    const context = `prefix length ${prefixLength}
source tail: ${JSON.stringify(prefix.slice(-80))}
previous visible tail: ${JSON.stringify(previousVisibleText.slice(-80))}
visible tail: ${JSON.stringify(visibleText.slice(-80))}
final visible tail: ${JSON.stringify(finalVisibleText.slice(-80))}`;

    expect(finalVisibleText.startsWith(visibleText), context).toBe(true);
    expect(visibleText.startsWith(previousVisibleText), context).toBe(true);

    previousVisibleText = visibleText;
  }
}

function hasSuspiciousVisibleTail(text: string): boolean {
  return (
    /(?:^|[^*])\*$/.test(text) ||
    text.endsWith("[") ||
    text.endsWith("]") ||
    text.endsWith("\\") ||
    text.endsWith("\\(") ||
    /\| ?$/.test(text) ||
    /\n\d+\.? ?$/.test(text) ||
    /\n\d+\.? ?\*$/.test(text) ||
    /\$[^$\n]*$/.test(text)
  );
}

function expectNoSuspiciousVisibleTail(
  ast: Root,
  context: string,
  source: string,
): void {
  const visibleText = renderVisibleText(ast);

  expect(
    hasSuspiciousVisibleTail(visibleText),
    `${context}
source tail: ${JSON.stringify(source.slice(-80))}
visible tail: ${JSON.stringify(visibleText.slice(-80))}`,
  ).toBe(false);
}

describe("optimistic projection audit", () => {
  it("does not publish suspicious raw tails across variable streaming chunks", () => {
    const session = createMarkdownSession();
    let source = "";
    let offset = 0;
    let chunkIndex = 0;

    while (offset < STREAMING_FIXTURE.length) {
      const chunkSize =
        VARIABLE_CHUNK_SIZES[chunkIndex % VARIABLE_CHUNK_SIZES.length] ?? 6;
      const nextOffset = Math.min(STREAMING_FIXTURE.length, offset + chunkSize);

      source += STREAMING_FIXTURE.slice(offset, nextOffset);
      offset = nextOffset;
      chunkIndex += 1;

      expectNoSuspiciousVisibleTail(
        session.parse(source, false).ast,
        `chunk ${chunkIndex}`,
        source,
      );
    }
  });

  it("does not publish suspicious raw tails across every char cut", () => {
    const session = createMarkdownSession();
    let source = "";

    for (const character of STREAMING_FIXTURE) {
      source += character;

      expectNoSuspiciousVisibleTail(
        session.parse(source, false).ast,
        `prefix length ${source.length}`,
        source,
      );
    }
  });

  it.each(MONOTONIC_STREAMING_CASES)(
    "keeps visible text monotonic while streaming: %s",
    (source) => {
      expectMonotonicVisibleTextAcrossEveryCut(source);
    },
  );
});
