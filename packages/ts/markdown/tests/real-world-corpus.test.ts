import { isDeepStrictEqual } from "node:util";

import type { Break, Root } from "mdast";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { describe, expect, it } from "vitest";

import { createMarkdownSession, parseMarkdown } from "../src/index.ts";
import { realWorldMarkdownFixtures } from "./fixtures/real-world-messages.ts";

const knownLegacyMismatches = [
  "real-world-002",
  "real-world-007",
  "real-world-009",
  "real-world-011",
  "real-world-013",
  "real-world-024",
  "real-world-048",
  "real-world-055",
  "real-world-080",
  "real-world-147",
  "real-world-158",
] as const;

type TreeNode = {
  children?: TreeNode[];
  type?: string;
  value?: unknown;
};

function reactMarkdownLineBreakDirective() {
  return (tree: Root) => {
    visitNodes(tree, (node) => {
      if (!("children" in node) || !Array.isArray(node.children)) return;

      const children = node.children;

      children.forEach((child, index) => {
        if (
          child !== null &&
          typeof child === "object" &&
          "type" in child &&
          child.type === "html" &&
          "value" in child &&
          child.value === "<br>"
        ) {
          const breakNode: Break = { type: "break" };

          children.splice(index, 1, breakNode);
        }
      });
    });
  };
}

function remarkHideSubsequentThematicBreaks() {
  return (tree: Root) => {
    visitNodes(tree, (_node, index, parent) => {
      if (!parent || index === undefined) return undefined;
      if (parent.children[index]?.type !== "thematicBreak") return undefined;
      if (parent.children[index - 1]?.type !== "thematicBreak") {
        return undefined;
      }

      parent.children.splice(index, 1);

      return index;
    });
  };
}

function parseWithLegacyLeChatPipeline(source: string): Root {
  const processor = remark()
    .use(remarkGfm)
    .use(remarkMath)
    .use(reactMarkdownLineBreakDirective)
    .use(remarkHideSubsequentThematicBreaks);

  return processor.runSync(processor.parse(source)) as Root;
}

function visitNodes(
  node: TreeNode,
  visitor: (
    node: TreeNode,
    index?: number,
    parent?: TreeNode & { children: TreeNode[] },
  ) => number | undefined | void,
): void {
  const nextIndex = visitor(node);

  if (nextIndex !== undefined) {
    return;
  }

  if (!("children" in node) || !Array.isArray(node.children)) {
    return;
  }

  const children = node.children;
  const parent = node as TreeNode & { children: TreeNode[] };

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];

    if (child === undefined) continue;

    const replacementIndex = visitor(child, index, parent);

    if (replacementIndex !== undefined) {
      index = replacementIndex - 1;
      continue;
    }

    visitNodes(child, visitor);
  }
}

function normalizeAst(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeAst);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  const normalized: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(value)) {
    if (key === "position") continue;
    if (
      key === "data" &&
      child !== null &&
      typeof child === "object" &&
      Object.keys(child).length === 0
    ) {
      continue;
    }

    normalized[key] = normalizeAst(child);
  }

  return normalized;
}

function parseIncrementally(source: string): Root {
  const session = createMarkdownSession();
  let currentSource = "";

  for (let index = 0; index < source.length; index += 1) {
    const chunkSize = (index % 7) + 1;
    const nextSource = source.slice(0, index + chunkSize);

    if (nextSource.length === currentSource.length) continue;

    currentSource = nextSource;
    session.parse(currentSource, false);
    index = currentSource.length - 1;
  }

  return session.parse(source, true).ast;
}

describe("real-world Le Chat markdown corpus", () => {
  it("contains a sanitized 200-message assistant corpus", () => {
    const allSources = realWorldMarkdownFixtures
      .map((fixture) => fixture.source)
      .join("\n");

    expect(realWorldMarkdownFixtures).toHaveLength(200);
    expect(allSources).not.toMatch(
      /Matthieu|Gicquel|\bU[0-9A-Z]{8,}\b|\b(?:ory|sk|mistral|mk)[_-][A-Za-z0-9_-]{16,}\b/,
    );
    expect(allSources).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    expect(allSources).not.toMatch(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
    );
  });

  it("tracks mdast compatibility with the current Le Chat remark pipeline", () => {
    const mismatches: string[] = [];

    for (const fixture of realWorldMarkdownFixtures) {
      const mistralAst = normalizeAst(parseMarkdown(fixture.source).ast);
      const legacyAst = normalizeAst(
        parseWithLegacyLeChatPipeline(fixture.source),
      );

      if (!isDeepStrictEqual(mistralAst, legacyAst)) {
        mismatches.push(fixture.id);
      }
    }

    expect(mismatches).toEqual(knownLegacyMismatches);
  });

  it("keeps all real-world final ASTs identical across incremental and one-shot parsing", () => {
    for (const fixture of realWorldMarkdownFixtures) {
      expect(parseIncrementally(fixture.source), fixture.id).toEqual(
        parseMarkdown(fixture.source).ast,
      );
    }
  }, 30_000);
});
