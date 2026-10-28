/**
 * The chat extensions, as one injectable seam.
 *
 * Chat serves only what its own routes back — the sessions rail and answer feedback (`./api`).
 * Dictation and read-aloud are contributed by other capabilities as chat extensions: modules under
 * `./extensions/`, found by the chat route (`./extensions`) and handed to `ChatApiProvider`.
 * Anything under the provider reads them with `useChatExtensions()`; a member no extension
 * provides is absent, and the control it would power is not offered.
 *
 * The default is no extensions, so a component rendered without a provider, as in most tests,
 * simply has no dictation or read-aloud.
 */
import type { ChatApi } from "@mistralai-capabilities/feature-chat";
import { createContext, useContext, type ReactNode } from "react";

/** What a chat extension may provide: the chat API members chat itself does not serve. */
export type ChatExtension = Partial<Pick<ChatApi, "transcribeAudio" | "synthesizeSpeech">>;

const NO_EXTENSIONS: ChatExtension = {};

const ChatExtensionsContext = createContext<ChatExtension>(NO_EXTENSIONS);

export type ChatApiProviderProps = {
  /** Every installed chat extension, merged. */
  extensions: ChatExtension;
  children: ReactNode;
};

export function ChatApiProvider({ extensions, children }: ChatApiProviderProps) {
  return (
    <ChatExtensionsContext.Provider value={extensions}>{children}</ChatExtensionsContext.Provider>
  );
}

export function useChatExtensions(): ChatExtension {
  return useContext(ChatExtensionsContext);
}
