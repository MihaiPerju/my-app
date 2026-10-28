import type { ChatContextValue } from "@mistralai-capabilities/feature-chat";
import { createContext, useContext } from "react";

export type { ChatContextValue } from "@mistralai-capabilities/feature-chat";

const NO_CONVERSATION: ChatContextValue = {
  messages: [],
  toolEvents: [],
  sessionId: null,
  isResponding: false,
};

/** Provided by the chat page around the conversation and the side app beside it. */
export const ChatContext = createContext<ChatContextValue>(NO_CONVERSATION);

/**
 * The conversation a chat side app sits beside: messages, tool events, session id, whether a turn
 * is in flight, and the live tool event that opened the side app (absent when opened by hand).
 * Available to every component under the chat layout route, so a side app reacts to what the
 * agent just did without chat passing it props. Outside the chat it reads an empty conversation.
 */
export function useChatContext(): ChatContextValue {
  return useContext(ChatContext);
}
