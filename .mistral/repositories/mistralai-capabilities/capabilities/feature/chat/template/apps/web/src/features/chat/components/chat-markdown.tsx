import type { parseMarkdown } from "@mistral/markdown";
import { sanitizeMarkdownUrl } from "@mistral/markdown/url";
import { useMemo } from "react";
import { useMarkdownLinkRenderer } from "../chat-markdown-link";
import { useMarkdownParser } from "../chat-markdown-parser";
import type { CSSProperties, ReactNode } from "react";

/**
 * `@mistral/markdown`'s incremental parser plus a hand-written mdast to JSX renderer, because
 * `@mistralai/ui`'s `<Markdown>` pulls in shiki, whose `onig.wasm` breaks the SSR build. The parser
 * is DOM-free, so one tree renders on server and browser. Untrusted output is contained: raw HTML is
 * inert (escaped, never `dangerouslySetInnerHTML`) and every `url` passes through `sanitizeMarkdownUrl`.
 */

// The parser's return type is the source of truth for the node union, so the renderer never imports
// mdast. `MarkdownNode` is one node in the parsed tree, narrowed per `type` below.
type MarkdownRoot = ReturnType<typeof parseMarkdown>["ast"];
type MarkdownNode = MarkdownRoot["children"][number];

const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

/** GFM alignment is one entry per column; honour only the values that map to a CSS text-align. */
function textAlignStyle(align: string | null | undefined): CSSProperties | undefined {
  if (align === "left" || align === "right" || align === "center") {
    return { textAlign: align };
  }

  return undefined;
}

function safeUrl(url: string): string {
  return sanitizeMarkdownUrl(url) ?? "";
}

// Keys are the node's structural path (parent key + sibling position). The tree is re-parsed whole
// from immutable text and never reordered, so a positional path is both stable and unique — and,
// unlike a bare loop index, it is not what `react/no-array-index-key` warns against.
function MarkdownChildren({ nodes, path }: { nodes?: readonly MarkdownNode[]; path: string }) {
  if (nodes === undefined) {
    return null;
  }

  return <>{nodes.map((node, index) => renderNode(node, `${path}.${index}`))}</>;
}

/**
 * A table is a flat list of `tableRow`s with no thead/tbody and no header flag: row 0 IS the
 * header. `align` is one entry per column, shared across every row.
 */
function MarkdownTable({
  node,
  path,
}: {
  node: Extract<MarkdownNode, { type: "table" }>;
  path: string;
}) {
  const [headerRow, ...bodyRows] = node.children;
  const align = node.align ?? [];

  return (
    <table>
      {headerRow ? (
        <thead>
          <tr>
            {headerRow.children.map((cell, index) => {
              const cellPath = `${path}.h.${index}`;

              return (
                <th key={cellPath} style={textAlignStyle(align[index])}>
                  <MarkdownChildren nodes={cell.children} path={cellPath} />
                </th>
              );
            })}
          </tr>
        </thead>
      ) : null}
      {bodyRows.length > 0 ? (
        <tbody>
          {bodyRows.map((row, rowIndex) => {
            const rowPath = `${path}.${rowIndex}`;

            return (
              <tr key={rowPath}>
                {row.children.map((cell, index) => {
                  const cellPath = `${rowPath}.${index}`;

                  return (
                    <td key={cellPath} style={textAlignStyle(align[index])}>
                      <MarkdownChildren nodes={cell.children} path={cellPath} />
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      ) : null}
    </table>
  );
}

/** A link, rendered by the app's `ChatMarkdownLinkProvider` renderer (see `chat-markdown-link`). */
function MarkdownLink({
  node,
  path,
}: {
  node: Extract<MarkdownNode, { type: "link" }>;
  path: string;
}) {
  const renderLink = useMarkdownLinkRenderer();

  return renderLink({
    href: safeUrl(node.url),
    title: node.title ?? undefined,
    children: <MarkdownChildren nodes={node.children} path={path} />,
  });
}

function renderNode(node: MarkdownNode, key: string): ReactNode {
  switch (node.type) {
    case "text":
      return node.value;
    case "paragraph":
      return (
        <p key={key}>
          <MarkdownChildren nodes={node.children} path={key} />
        </p>
      );
    case "heading": {
      const Tag = HEADING_TAGS[node.depth - 1] ?? "h1";

      return (
        <Tag key={key}>
          <MarkdownChildren nodes={node.children} path={key} />
        </Tag>
      );
    }
    case "strong":
      return (
        <strong key={key}>
          <MarkdownChildren nodes={node.children} path={key} />
        </strong>
      );
    case "emphasis":
      return (
        <em key={key}>
          <MarkdownChildren nodes={node.children} path={key} />
        </em>
      );
    case "delete":
      return (
        <del key={key}>
          <MarkdownChildren nodes={node.children} path={key} />
        </del>
      );
    case "inlineCode":
      return <code key={key}>{node.value}</code>;
    case "code":
      // The parser strips the fence's trailing newline; re-add it so a `<pre><code>` reads as the
      // block it was written as.
      return (
        <pre key={key}>
          <code
            className={node.lang ? `language-${node.lang}` : undefined}
          >{`${node.value}\n`}</code>
        </pre>
      );
    case "link":
      return <MarkdownLink key={key} node={node} path={key} />;
    case "image":
      return (
        <img
          key={key}
          src={safeUrl(node.url)}
          alt={node.alt ?? ""}
          title={node.title ?? undefined}
        />
      );
    case "list":
      return node.ordered ? (
        <ol key={key} start={node.start ?? undefined}>
          <MarkdownChildren nodes={node.children} path={key} />
        </ol>
      ) : (
        <ul key={key}>
          <MarkdownChildren nodes={node.children} path={key} />
        </ul>
      );
    case "listItem":
      return (
        <li key={key}>
          {/* GFM task item: `checked` is a boolean when the item is a task, and null otherwise. */}
          {node.checked === true || node.checked === false ? (
            <input type="checkbox" checked={node.checked} disabled readOnly />
          ) : null}
          <MarkdownChildren nodes={node.children} path={key} />
        </li>
      );
    case "table":
      return <MarkdownTable key={key} node={node} path={key} />;
    case "blockquote":
      return (
        <blockquote key={key}>
          <MarkdownChildren nodes={node.children} path={key} />
        </blockquote>
      );
    case "thematicBreak":
      return <hr key={key} />;
    case "break":
      return <br key={key} />;
    case "inlineMath":
      // No katex: the TeX source is shown inert rather than typeset.
      return <code key={key}>{node.value}</code>;
    case "math":
      return (
        <pre key={key}>
          <code>{`${node.value}\n`}</code>
        </pre>
      );
    case "html":
      // Untrusted raw HTML from the model. Rendered as escaped text — never as live markup.
      return node.value;
    default:
      // Anything else (e.g. footnote definitions) still surfaces its text rather than vanishing.
      if ("children" in node) {
        return <MarkdownChildren key={key} nodes={node.children} path={key} />;
      }

      if ("value" in node) {
        return node.value;
      }

      return null;
  }
}

type MarkdownSurfaceProps = {
  children: string;
  className?: string;
};

/**
 * The one parse per message, memoised on its text.
 *
 * `parseMarkdown` is called directly, not `useMistralMarkdown`, whose async smoothing can withhold
 * text and destabilise this memo and the streaming test. A plain module-scope import also lets
 * `chat-thread-memo.test.tsx` mock it to count parses.
 */
export function MarkdownSurface({ children, className }: MarkdownSurfaceProps) {
  const parseMarkdown = useMarkdownParser();
  const { ast } = useMemo(() => parseMarkdown(children), [children, parseMarkdown]);

  return (
    <div className={["markdown-container-style", className].filter(Boolean).join(" ")}>
      <MarkdownChildren nodes={ast.children} path="md" />
    </div>
  );
}
