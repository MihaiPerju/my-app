import type { Link, Nodes, Paragraph, PhrasingContent } from "mdast";

import type { UnstableMarkdownTransform } from "./types";

export type SpecialUriLinkNode = {
  readonly type: "specialUriLink";
  readonly url: string;
  readonly children: PhrasingContent[];
  readonly data: {
    readonly hName: "special-uri-link";
    readonly hProperties: {
      readonly href: string;
    };
  };
};

declare module "mdast" {
  interface BlockContentMap {
    specialUriLink: SpecialUriLinkNode;
  }

  interface PhrasingContentMap {
    specialUriLink: SpecialUriLinkNode;
  }

  interface RootContentMap {
    specialUriLink: SpecialUriLinkNode;
  }
}

/**
 * Normalizes literal HTML `<br>` leaves to mdast `break` nodes.
 *
 * LLMs commonly emit `<br>` when they want a visible line break in otherwise
 * markdown-shaped text. The parser keeps HTML syntax intact by default; this
 * transform is an opt-in projection for renderers that want markdown break
 * semantics for that common model idiosyncrasy.
 */
export const htmlBreaksToMarkdownBreaks = {
  parentTypes: [
    "paragraph",
    "heading",
    "tableCell",
    "link",
    "strong",
    "emphasis",
    "delete",
  ],
  transform(children) {
    let nextChildren: Nodes[] | undefined;

    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      const replacement =
        child?.type === "html" && isHtmlBreak(child.value)
          ? ({ type: "break" } satisfies Nodes)
          : child;

      if (replacement === child && nextChildren === undefined) {
        continue;
      }

      nextChildren ??= children.slice(0, index);

      if (replacement !== undefined) {
        nextChildren.push(replacement);
      }
    }

    return nextChildren ?? children;
  },
} satisfies UnstableMarkdownTransform;

/**
 * Reprojects simple one-item ordered lists as paragraphs with their number.
 *
 * LLMs can emit a numbered section label between prose blocks. CommonMark
 * correctly parses that label as a list, but a paragraph is usually a more
 * useful rendering for this model output.
 */
export const singleItemOrderedListsToParagraphs = {
  parentTypes: ["root", "blockquote", "listItem", "footnoteDefinition"],
  transform(children) {
    let nextChildren: Nodes[] | undefined;

    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      const item = child?.type === "list" ? child.children[0] : undefined;
      const paragraph = item?.children[0];
      const replacement =
        child?.type === "list" &&
        child.ordered &&
        child.children.length === 1 &&
        item?.children.length === 1 &&
        item.checked === null &&
        paragraph?.type === "paragraph"
          ? ({
              ...paragraph,
              children: [
                { type: "text", value: `${child.start ?? 1}. ` },
                ...paragraph.children,
              ],
            } satisfies Paragraph)
          : child;

      if (replacement === child && nextChildren === undefined) {
        continue;
      }

      nextChildren ??= children.slice(0, index);

      if (replacement !== undefined) {
        nextChildren.push(replacement);
      }
    }

    return nextChildren ?? children;
  },
} satisfies UnstableMarkdownTransform;

export const llmCompatibilityTransforms = [
  htmlBreaksToMarkdownBreaks,
  singleItemOrderedListsToParagraphs,
] as const satisfies readonly UnstableMarkdownTransform[];

/**
 * Lifts selected links out of paragraphs so renderers may replace them with
 * block UI without producing invalid paragraph markup.
 *
 * This is useful for Mistral generalized-reference placement links such as
 * `[Chart](component://...)`: markdown still owns placement and fallback text,
 * while the consumer owns URI registration and rendering.
 */
export function liftSpecialUriLinks(
  isSpecialUriLink: (uri: string) => boolean,
): UnstableMarkdownTransform {
  return {
    parentTypes: ["root", "blockquote", "listItem", "footnoteDefinition"],
    transform(children) {
      let nextChildren: Nodes[] | undefined;

      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];

        if (child?.type !== "paragraph") {
          if (child !== undefined) {
            nextChildren?.push(child);
          }
          continue;
        }

        const split = splitParagraphOnSpecialUriLinks(child, isSpecialUriLink);

        if (split === undefined) {
          nextChildren?.push(child);
          continue;
        }

        nextChildren ??= children.slice(0, index);
        nextChildren.push(...split);
      }

      return nextChildren ?? children;
    },
  };
}

function isHtmlBreak(value: string): boolean {
  return /^<br[ \t\n\f\r]*\/?[ \t\n\f\r]*>$/i.test(value);
}

function splitParagraphOnSpecialUriLinks(
  paragraph: Paragraph,
  isSpecialUriLink: (uri: string) => boolean,
): Nodes[] | undefined {
  let nodes: Nodes[] | undefined;
  let pendingChildren: PhrasingContent[] = [];

  for (const child of paragraph.children) {
    if (child.type === "link" && isSpecialUriLink(child.url.trim())) {
      nodes ??= [];

      if (hasVisibleChildren(pendingChildren)) {
        nodes.push({ type: "paragraph", children: pendingChildren });
      }

      pendingChildren = [];
      nodes.push(createSpecialUriLinkNode(child));
      continue;
    }

    pendingChildren.push(child);
  }

  if (nodes === undefined) {
    return undefined;
  }

  if (hasVisibleChildren(pendingChildren)) {
    nodes.push({ type: "paragraph", children: pendingChildren });
  }

  return nodes;
}

function createSpecialUriLinkNode(link: Link): SpecialUriLinkNode {
  const url = link.url.trim();

  return {
    type: "specialUriLink",
    url,
    data: {
      hName: "special-uri-link",
      hProperties: {
        href: url,
      },
    },
    children: link.children,
  };
}

function hasVisibleChildren(children: readonly PhrasingContent[]): boolean {
  return children.some(
    (child) => child.type !== "text" || child.value.trim() !== "",
  );
}
