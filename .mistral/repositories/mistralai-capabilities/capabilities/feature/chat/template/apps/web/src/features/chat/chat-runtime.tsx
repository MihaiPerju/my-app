/**
 * The composition layer over the chat feature's four injectable seams.
 *
 * Each third-party dependency lives behind its own narrow context — the transport hook
 * (`chat-transport`), the animation primitives (`chat-motion`) and the markdown parser
 * (`chat-markdown-parser`) — so a consumer only ever imports the seam it uses and never sees a
 * dependency it does not. The fourth, the markdown link renderer (`chat-markdown-link`), is the
 * app's own hook into how answer links behave. This provider exists purely so a test can override any subset of the four
 * in one wrapper; it nests the seam providers, defaulting each to its real implementation.
 *
 * There is deliberately no combined accessor hook here: a "give me everything" hook would
 * reintroduce the service locator these seams replaced.
 */
import type { ReactNode } from "react";

import { ChatMarkdownLinkProvider, type ChatMarkdownLinkOverride } from "./chat-markdown-link";
import {
  ChatMarkdownParserProvider,
  type ChatMarkdownParserOverride,
} from "./chat-markdown-parser";
import { ChatMotionProvider, type ChatMotionOverride } from "./chat-motion";
import { ChatTransportProvider, type ChatTransportOverride } from "./chat-transport";

export type ChatRuntimeProviderProps = {
  transport?: ChatTransportOverride;
  motion?: ChatMotionOverride;
  markdown?: ChatMarkdownParserOverride;
  link?: ChatMarkdownLinkOverride;
  children: ReactNode;
};

export function ChatRuntimeProvider({
  transport,
  motion,
  markdown,
  link,
  children,
}: ChatRuntimeProviderProps) {
  return (
    <ChatTransportProvider {...transport}>
      <ChatMotionProvider {...motion}>
        <ChatMarkdownParserProvider {...markdown}>
          <ChatMarkdownLinkProvider {...link}>{children}</ChatMarkdownLinkProvider>
        </ChatMarkdownParserProvider>
      </ChatMotionProvider>
    </ChatTransportProvider>
  );
}
