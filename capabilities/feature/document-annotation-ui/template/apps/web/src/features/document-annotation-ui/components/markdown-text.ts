/**
 * Text/markdown helpers shared by the Raw OCR and Markdown tabs.
 */

import { z } from "zod";

/**
 * Markdown styling, inlined rather than taken from a typography plugin.
 *
 * The review panel is a dense reading surface, and the design system's `Markdown` defaults are tuned
 * for chat. These element rules keep a multi-page OCR dump readable at `text-sm` in a half-width pane.
 */
export const MD_PROSE =
  "text-default text-sm leading-relaxed [&_h1]:mt-3 [&_h1]:mb-1 [&_h1]:font-semibold [&_h1]:text-base " +
  "[&_h2]:mt-3 [&_h2]:mb-1 [&_h2]:font-semibold [&_h2]:text-sm [&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:font-semibold " +
  "[&_p]:my-1.5 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 " +
  "[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-default " +
  "[&_th]:bg-subtle [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:border-default " +
  "[&_td]:px-2 [&_td]:py-1 [&_a]:text-brand-600 [&_a]:underline [&_code]:rounded [&_code]:bg-subtle [&_code]:px-1";

/**
 * The OCR image id a markdown `![](…)` reference points at, or undefined when it is not an OCR
 * object (empty, an embedded data URL, or an absolute URL).
 *
 * OCR emits `![](img-0.jpeg)`-style relative references and stores the bytes separately by name; the
 * viewer fetches them by id. A relative id returns its bare leaf so a nested path still resolves.
 */
export function ocrImageId(src: string | undefined): string | undefined {
  if (!src) return undefined;
  if (src.startsWith("data:") || src.startsWith("http")) return undefined;
  return src.split("/").pop() ?? src;
}

/**
 * The 1-based line numbers of every GFM table header row, in document order.
 *
 * mdast reports a table node's start line, so the Nth entry identifies the Nth rendered table. This
 * lets the Markdown tab pair rendered tables with table regions by position, not by text, which reflows.
 */
function isTableDelimiterRow(line: string): boolean {
  return line.includes("|") && line.includes("-") && /^[\s:|-]+$/.test(line);
}

export function findTableHeaderLines(markdown: string): Array<number> {
  const lines = markdown.split("\n");
  const headerLines: Array<number> = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    const previous = lines[index - 1];
    if (
      line !== undefined &&
      previous !== undefined &&
      isTableDelimiterRow(line) &&
      previous.includes("|")
    ) {
      // The header sits at array index `index - 1`, i.e. 1-indexed line number `index`.
      headerLines.push(index);
    }
  }
  return headerLines;
}

/**
 * The mdast node `react-markdown` injects into every custom component, narrowed to its position.
 *
 * `react-markdown` types this prop loosely, so `isMdastNode` decodes it at the boundary — anything
 * that does not decode is treated as position-less — and `nodeStartLine` reads the one nested path
 * we care about: the 1-based start line mdast records for the node.
 */
export type MdastNode = { readonly position?: { readonly start?: { readonly line?: number } } };

const mdastNodeSchema = z.looseObject({
  position: z.looseObject({ start: z.looseObject({ line: z.number() }).optional() }).optional(),
});

export function isMdastNode(value: unknown): value is MdastNode {
  return mdastNodeSchema.safeParse(value).success;
}

export function nodeStartLine(node: MdastNode): number | undefined {
  return node.position?.start?.line;
}
