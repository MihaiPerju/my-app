/**
 * The Vibe Agents chat hook, as one injectable seam.
 *
 * `useAgentChat` is a library the feature imports rather than owns, and a test needs to stand in for
 * it. Naming it here is what lets a test replace it through the React tree instead of rewriting a
 * module in the loader: bun's `mock.module` is process-wide, so a stand-in installed by one test
 * file would leak into every other file in the run. A context override is scoped to the subtree that
 * renders under it.
 *
 * The default is the real hook, so nothing outside a test has to provide anything and a component
 * rendered without a provider behaves exactly as it did before this seam existed.
 */
import { useAgentChat } from "@mistral/workflow-ui/agents/react";
import { createContext, type ReactNode } from "react";

export type UseAgentChatHook = typeof useAgentChat;

export type ChatTransportOverride = {
  useAgentChat?: UseAgentChatHook;
};
/* oxlint-disable react/hooks -- This module is the deliberate injectable-hook test seam. */
export const ChatTransportContext = createContext<UseAgentChatHook>(useAgentChat);

export function ChatTransportProvider({
  useAgentChat: hook = useAgentChat,
  children,
}: ChatTransportOverride & { children: ReactNode }) {
  return <ChatTransportContext.Provider value={hook}>{children}</ChatTransportContext.Provider>;
}
/* oxlint-enable react/hooks */
