/**
 * How an answer's markdown links render, as one injectable seam.
 *
 * Model output is untrusted, so a link leaves the page by default: a new tab, with no opener handed
 * over. An in-page anchor (`#…`) is the exception and stays on the page, because opening a copy of
 * the app in a new tab to follow it is never what a reader wants. An app whose answers carry its own
 * links (a citation that focuses a graph node, a route inside the app) replaces the renderer by
 * wrapping `ChatPage` in `ChatMarkdownLinkProvider`:
 *
 * ```tsx
 * <ChatMarkdownLinkProvider
 *   renderLink={(link) =>
 *     link.href.startsWith("#node=") ? <a href={link.href}>{link.children}</a> : defaultRenderLink(link)
 *   }
 * >
 *   <ChatPage … />
 * </ChatMarkdownLinkProvider>
 * ```
 *
 * `href` has already been through `sanitizeMarkdownUrl`, so a renderer never sees a `javascript:` url.
 */
import { createContext, useContext, type ReactNode } from "react";

export type ChatMarkdownLink = {
  /** The sanitized url; empty when sanitizing refused it. */
  href: string;
  title: string | undefined;
  children: ReactNode;
};

export type ChatMarkdownLinkRenderer = (link: ChatMarkdownLink) => ReactNode;

export function isInPageLink(href: string): boolean {
  return href.startsWith("#");
}

export const defaultRenderLink: ChatMarkdownLinkRenderer = ({ href, title, children }) =>
  isInPageLink(href) ? (
    <a href={href} title={title}>
      {children}
    </a>
  ) : (
    <a href={href} title={title} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );

export type ChatMarkdownLinkOverride = {
  renderLink?: ChatMarkdownLinkRenderer;
};

const ChatMarkdownLinkContext = createContext<ChatMarkdownLinkRenderer>(defaultRenderLink);

export function ChatMarkdownLinkProvider({
  renderLink = defaultRenderLink,
  children,
}: ChatMarkdownLinkOverride & { children: ReactNode }) {
  return (
    <ChatMarkdownLinkContext.Provider value={renderLink}>
      {children}
    </ChatMarkdownLinkContext.Provider>
  );
}

export function useMarkdownLinkRenderer(): ChatMarkdownLinkRenderer {
  return useContext(ChatMarkdownLinkContext);
}
