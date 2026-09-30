import type {
  AlignType,
  BlockContent,
  Blockquote,
  Break,
  Code,
  Delete,
  Emphasis,
  FootnoteDefinition,
  FootnoteReference,
  Heading,
  Html,
  Image,
  InlineMath,
  InlineCode,
  Link,
  List,
  ListItem,
  Math as MarkdownMath,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Strong,
  Table,
  TableCell,
  TableRow,
  Text,
} from "mdast";

import { parseHtmlTagStart } from "./html-scan";
import type { SpecialUriLinkNode } from "./transforms";

const DISALLOWED_RAW_HTML_TAG_NAMES = new Set([
  "title",
  "textarea",
  "style",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "script",
  "plaintext",
]);

type RenderHtmlOptions = {
  readonly collapseNestedStrong?: boolean;
  readonly gfmTagFilter?: boolean;
};

type RenderContext = {
  readonly options: RenderHtmlOptions;
  readonly footnoteNumbers: Map<string, number>;
  readonly footnoteOrder: string[];
  readonly footnoteReferenceIds: Map<string, string[]>;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function createRenderContext(options: RenderHtmlOptions): RenderContext {
  return {
    options,
    footnoteNumbers: new Map(),
    footnoteOrder: [],
    footnoteReferenceIds: new Map(),
  };
}

function getFootnoteFragment(identifier: string): string {
  return encodeURI(identifier);
}

function registerFootnoteReference(
  context: RenderContext,
  identifier: string,
): {
  readonly footnoteNumber: number;
  readonly fragment: string;
  readonly referenceId: string;
} {
  let footnoteNumber = context.footnoteNumbers.get(identifier);

  if (footnoteNumber === undefined) {
    footnoteNumber = context.footnoteNumbers.size + 1;
    context.footnoteNumbers.set(identifier, footnoteNumber);
    context.footnoteOrder.push(identifier);
  }

  let referenceIds = context.footnoteReferenceIds.get(identifier);

  if (referenceIds === undefined) {
    referenceIds = [];
    context.footnoteReferenceIds.set(identifier, referenceIds);
  }

  const occurrence = referenceIds.length + 1;
  const fragment = getFootnoteFragment(identifier);
  const referenceId =
    occurrence === 1 ? `fnref-${fragment}` : `fnref-${fragment}-${occurrence}`;

  referenceIds.push(referenceId);

  return {
    footnoteNumber,
    fragment,
    referenceId,
  };
}

function renderText(node: Text): string {
  return escapeHtml(node.value);
}

function renderBreak(_node: Break): string {
  return "<br />\n";
}

function renderEmphasis(node: Emphasis, context: RenderContext): string {
  return `<em>${node.children.map((child) => renderInline(child, context, "emphasis")).join("")}</em>`;
}

function renderDelete(node: Delete, context: RenderContext): string {
  return `<del>${node.children.map((child) => renderInline(child, context, "delete")).join("")}</del>`;
}

function renderStrong(
  node: Strong,
  context: RenderContext,
  parentType?: PhrasingContent["type"],
): string {
  const content = node.children
    .map((child) => renderInline(child, context, "strong"))
    .join("");

  if (
    context.options.collapseNestedStrong === true &&
    parentType === "strong"
  ) {
    return content;
  }

  return `<strong>${content}</strong>`;
}

function renderInlineCode(node: InlineCode): string {
  return `<code>${escapeHtml(node.value)}</code>`;
}

function renderInlineMath(node: InlineMath): string {
  return `<code class="language-math math-inline">${escapeHtml(node.value)}</code>`;
}

function renderHtml(node: Html, context: RenderContext): string {
  if (context.options.gfmTagFilter !== true) {
    return node.value;
  }

  let filtered = "";
  let segmentStart = 0;

  for (let index = 0; index < node.value.length; index += 1) {
    if (node.value[index] !== "<") {
      continue;
    }

    const tag = parseHtmlTagStart(node.value, index);

    if (tag === null || !DISALLOWED_RAW_HTML_TAG_NAMES.has(tag.name)) {
      continue;
    }

    filtered += `${node.value.slice(segmentStart, index)}&lt;`;
    segmentStart = index + 1;
  }

  return segmentStart === 0
    ? node.value
    : filtered + node.value.slice(segmentStart);
}

function renderLink(node: Link, context: RenderContext): string {
  const titleAttribute =
    node.title === null || node.title === undefined
      ? ""
      : ` title="${escapeHtml(node.title)}"`;

  return `<a href="${escapeHtml(node.url)}"${titleAttribute}>${node.children.map((child) => renderInline(child, context, "link")).join("")}</a>`;
}

function renderImage(node: Image): string {
  const titleAttribute =
    node.title === null || node.title === undefined
      ? ""
      : ` title="${escapeHtml(node.title)}"`;

  return `<img src="${escapeHtml(node.url)}" alt="${escapeHtml(node.alt ?? "")}"${titleAttribute} />`;
}

function renderFootnoteReference(
  node: FootnoteReference,
  context: RenderContext,
): string {
  const { footnoteNumber, fragment, referenceId } = registerFootnoteReference(
    context,
    node.identifier,
  );

  return `<sup class="footnote-ref"><a href="#fn-${escapeHtml(fragment)}" id="${escapeHtml(referenceId)}" data-footnote-ref>${footnoteNumber}</a></sup>`;
}

function renderInline(
  node: PhrasingContent,
  context: RenderContext,
  parentType?: PhrasingContent["type"],
): string {
  switch (node.type) {
    case "break":
      return renderBreak(node);
    case "delete":
      return renderDelete(node, context);
    case "emphasis":
      return renderEmphasis(node, context);
    case "footnoteReference":
      return renderFootnoteReference(node, context);
    case "html":
      return renderHtml(node, context);
    case "image":
      return renderImage(node);
    case "inlineCode":
      return renderInlineCode(node);
    case "inlineMath":
      return renderInlineMath(node);
    case "link":
      return renderLink(node, context);
    case "specialUriLink":
      return renderSpecialUriLink(node, context);
    case "strong":
      return renderStrong(node, context, parentType);
    case "text":
      return renderText(node);
    default:
      return "";
  }
}

function renderInlineChildren(
  children: readonly PhrasingContent[],
  context: RenderContext,
): string {
  return children.map((child) => renderInline(child, context)).join("");
}

function renderParagraph(
  node: Paragraph,
  context: RenderContext,
  prefix = "",
): string {
  return `<p>${prefix}${renderInlineChildren(node.children, context)}</p>\n`;
}

function renderHeading(node: Heading, context: RenderContext): string {
  return `<h${node.depth}>${node.children.map((child) => renderInline(child, context)).join("")}</h${node.depth}>\n`;
}

function renderCode(node: Code): string {
  const className =
    node.lang === null || node.lang === undefined || node.lang === ""
      ? ""
      : ` class="language-${escapeHtml(node.lang)}"`;
  const value = node.value.length === 0 ? "" : `${node.value}\n`;

  return `<pre><code${className}>${escapeHtml(value)}</code></pre>\n`;
}

function renderMath(node: MarkdownMath): string {
  return `<pre><code class="language-math">${escapeHtml(node.value)}</code></pre>\n`;
}

function renderTaskListCheckbox(checked: boolean): string {
  return checked
    ? '<input checked="" disabled="" type="checkbox">'
    : '<input disabled="" type="checkbox">';
}

function renderTableCell(
  node: TableCell,
  tag: "td" | "th",
  align?: AlignType,
  context?: RenderContext,
): string {
  const alignAttribute =
    align === undefined || align === null ? "" : ` align="${align}"`;

  return `<${tag}${alignAttribute}>${renderInlineChildren(node.children, context ?? createRenderContext({}))}</${tag}>\n`;
}

function renderTableRow(
  node: TableRow,
  cellTag: "td" | "th",
  align: readonly AlignType[],
  context: RenderContext,
): string {
  return `<tr>\n${node.children.map((cell, index) => renderTableCell(cell, cellTag, align[index], context)).join("")}</tr>\n`;
}

function renderTable(node: Table, context: RenderContext): string {
  const [header, ...body] = node.children;

  if (header === undefined) {
    return "<table>\n</table>\n";
  }

  const align = node.align ?? [];
  const headerHtml = `<thead>\n${renderTableRow(header, "th", align, context)}</thead>\n`;
  const bodyHtml =
    body.length === 0
      ? ""
      : `<tbody>\n${body.map((row) => renderTableRow(row, "td", align, context)).join("")}</tbody>\n`;

  return `<table>\n${headerHtml}${bodyHtml}</table>\n`;
}

function renderSpecialUriLink(
  node: SpecialUriLinkNode,
  context: RenderContext,
): string {
  return `<a href="${escapeHtml(node.url)}">${renderInlineChildren(node.children, context)}</a>`;
}

function renderListItem(
  node: ListItem,
  tight: boolean,
  context: RenderContext,
): string {
  const checkbox =
    node.checked === null || node.checked === undefined
      ? null
      : renderTaskListCheckbox(node.checked);

  if (tight) {
    if (node.children.length === 0) {
      return checkbox === null ? "<li></li>\n" : `<li>${checkbox}</li>\n`;
    }

    let content = "";
    let renderedCheckbox = false;

    for (let index = 0; index < node.children.length; index += 1) {
      const child = node.children[index];

      if (child === undefined) {
        continue;
      }

      if (child.type === "paragraph") {
        const paragraphContent = renderInlineChildren(child.children, context);

        if (!renderedCheckbox && checkbox !== null) {
          content +=
            paragraphContent.length === 0
              ? checkbox
              : `${checkbox} ${paragraphContent}`;
          renderedCheckbox = true;
        } else {
          content += paragraphContent;
        }

        if (index < node.children.length - 1) {
          content += "\n";
        }

        continue;
      }

      if (!renderedCheckbox && checkbox !== null) {
        content += `${checkbox}\n`;
        renderedCheckbox = true;
      } else if (index === 0) {
        content += "\n";
      }

      content += renderNode(child, context);
    }

    return `<li>${content}</li>\n`;
  }

  if (node.children.length === 0) {
    return checkbox === null ? "<li></li>\n" : `<li>${checkbox}</li>\n`;
  }

  let content = "";
  let renderedCheckbox = false;

  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];

    if (child === undefined) {
      continue;
    }

    if (!renderedCheckbox && checkbox !== null && child.type === "paragraph") {
      content += renderParagraph(
        child,
        context,
        child.children.length === 0 ? checkbox : `${checkbox} `,
      );
      renderedCheckbox = true;
      continue;
    }

    if (!renderedCheckbox && checkbox !== null) {
      content += `${checkbox}\n`;
      renderedCheckbox = true;
    }

    content += renderNode(child, context);
  }

  return `<li>\n${content}</li>\n`;
}

function renderList(node: List, context: RenderContext): string {
  const tag = node.ordered ? "ol" : "ul";
  const startAttribute =
    node.ordered &&
    node.start !== null &&
    node.start !== undefined &&
    node.start !== 1
      ? ` start="${node.start}"`
      : "";
  const tight = node.spread !== true;

  return `<${tag}${startAttribute}>\n${node.children.map((child) => renderListItem(child, tight, context)).join("")}</${tag}>\n`;
}

function renderBlockQuote(node: Blockquote, context: RenderContext): string {
  return `<blockquote>\n${node.children.map((child) => renderNode(child, context)).join("")}</blockquote>\n`;
}

function renderNode(
  node: BlockContent | RootContent,
  context: RenderContext,
): string {
  switch (node.type) {
    case "blockquote":
      return renderBlockQuote(node, context);
    case "code":
      return renderCode(node);
    case "heading":
      return renderHeading(node, context);
    case "html":
      return renderHtml(node, context);
    case "list":
      return renderList(node, context);
    case "math":
      return renderMath(node);
    case "paragraph":
      return renderParagraph(node, context);
    case "specialUriLink":
      return `${renderSpecialUriLink(node, context)}\n`;
    case "table":
      return renderTable(node, context);
    case "thematicBreak":
      return "<hr />\n";
    default:
      throw new Error(`Unsupported HTML projection node type: ${node.type}`);
  }
}

function renderFootnoteBackrefs(
  identifier: string,
  context: RenderContext,
): string {
  const footnoteNumber = context.footnoteNumbers.get(identifier);
  const referenceIds = context.footnoteReferenceIds.get(identifier);

  if (footnoteNumber === undefined || referenceIds === undefined) {
    return "";
  }

  return referenceIds
    .map((referenceId, index) => {
      const occurrence = index + 1;
      const backrefIndex =
        occurrence === 1
          ? `${footnoteNumber}`
          : `${footnoteNumber}-${occurrence}`;
      const suffix =
        occurrence === 1
          ? "↩"
          : `↩<sup class="footnote-ref">${occurrence}</sup>`;

      return `<a href="#${escapeHtml(referenceId)}" class="footnote-backref" data-footnote-backref data-footnote-backref-idx="${escapeHtml(backrefIndex)}" aria-label="${escapeHtml(`Back to reference ${backrefIndex}`)}">${suffix}</a>`;
    })
    .join(" ");
}

function appendBackrefsToParagraph(html: string, backrefs: string): string {
  if (backrefs.length === 0) {
    return html;
  }

  if (html.endsWith("</p>\n")) {
    const withoutSuffix = html.slice(0, -"</p>\n".length);
    const separator = withoutSuffix.endsWith("<p>") ? "" : " ";

    return `${withoutSuffix}${separator}${backrefs}</p>\n`;
  }

  if (html.endsWith("</p>")) {
    const withoutSuffix = html.slice(0, -"</p>".length);
    const separator = withoutSuffix.endsWith("<p>") ? "" : " ";

    return `${withoutSuffix}${separator}${backrefs}</p>`;
  }

  return `${html}${backrefs}`;
}

function renderFootnoteDefinition(
  node: FootnoteDefinition,
  context: RenderContext,
): string {
  const renderedChildren = node.children.map((child) =>
    renderNode(child, context),
  );
  const backrefs = renderFootnoteBackrefs(node.identifier, context);

  if (backrefs.length > 0) {
    if (
      node.children.at(-1)?.type === "paragraph" &&
      renderedChildren.length > 0
    ) {
      renderedChildren[renderedChildren.length - 1] = appendBackrefsToParagraph(
        renderedChildren[renderedChildren.length - 1] ?? "",
        backrefs,
      );
    } else {
      renderedChildren.push(`${backrefs}\n`);
    }
  }

  return `<li id="fn-${escapeHtml(getFootnoteFragment(node.identifier))}">\n${renderedChildren.join("")}</li>\n`;
}

export function renderMarkdownAstToHtml(
  ast: Root,
  options: RenderHtmlOptions = {},
): string {
  const context = createRenderContext(options);
  const footnoteDefinitions = new Map<string, FootnoteDefinition>();
  let html = "";

  for (const child of ast.children) {
    if (child.type === "footnoteDefinition") {
      if (!footnoteDefinitions.has(child.identifier)) {
        footnoteDefinitions.set(child.identifier, child);
      }

      continue;
    }

    html += renderNode(child, context);
  }

  if (context.footnoteOrder.length === 0) {
    return html;
  }

  const items = context.footnoteOrder
    .map((identifier) => footnoteDefinitions.get(identifier))
    .filter(
      (definition): definition is FootnoteDefinition =>
        definition !== undefined,
    )
    .map((definition) => renderFootnoteDefinition(definition, context))
    .join("");

  if (items.length === 0) {
    return html;
  }

  return `${html}<section class="footnotes" data-footnotes>\n<ol>\n${items}</ol>\n</section>\n`;
}
