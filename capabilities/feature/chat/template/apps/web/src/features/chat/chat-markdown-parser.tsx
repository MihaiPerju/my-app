/**
 * The markdown parser, as one injectable seam.
 *
 * `parseMarkdown` is a library the feature imports rather than owns, and the memoisation test has to
 * count its runs. Naming it here lets a test replace it through the React tree instead of the module
 * loader: bun's `mock.module` is process-wide and would leak across files, and the previous markdown
 * stand-in had to delegate to the real parser specifically to stay harmless. A context override is
 * scoped to the subtree that renders under it.
 *
 * The default is the real parser, so nothing outside a test has to provide anything and a component
 * rendered without a provider behaves exactly as it did before this seam existed.
 */
import { parseMarkdown } from "@mistral/markdown";
import { createContext, useContext, type ReactNode } from "react";

export type MarkdownParser = typeof parseMarkdown;

export type ChatMarkdownParserOverride = {
  parseMarkdown?: MarkdownParser;
};

const ChatMarkdownParserContext = createContext<MarkdownParser>(parseMarkdown);

export function ChatMarkdownParserProvider({
  parseMarkdown: parser = parseMarkdown,
  children,
}: ChatMarkdownParserOverride & { children: ReactNode }) {
  return (
    <ChatMarkdownParserContext.Provider value={parser}>
      {children}
    </ChatMarkdownParserContext.Provider>
  );
}

export function useMarkdownParser(): MarkdownParser {
  return useContext(ChatMarkdownParserContext);
}
