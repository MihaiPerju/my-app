import type { AgentEvent, AgentMessage } from "@mistral/workflow-ui/agents";
import type { ChatMessage, ChatToolEvent } from "@mistralai-capabilities/feature-chat";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { CHAT_AGENT } from "./chat-provider";
import { ChatTransportContext, type UseAgentChatHook } from "./chat-transport";

// Re-exported so the thread, the page and their tests keep importing the shape from the hook
// that produces it. `UseChatOptions` / `UseChatResult` below stay here rather than moving to
// the package: this hook is built on `useAgentChat` and reads `AgentMessage`, and the package
// must not import `@mistral/workflow-ui`.
export type {
  ChatMessage,
  ChatMessageRole,
  ChatToolEvent,
} from "@mistralai-capabilities/feature-chat";

const FAILURE_FALLBACK = "The agent request failed. Please try again.";

export type UseChatOptions = {
  /**
   * The durable session to continue, or `null` for a fresh one whose id the SDK mints on the
   * first turn and reports through `onSessionIdChange`. Left `undefined`, the hook owns the id
   * itself (uncontrolled) — the shape the bare-rendered tests use.
   */
  sessionId?: string | null;
  onSessionIdChange?: (sessionId: string | null) => void;
};

export type UseChatResult = {
  sessionId: string | null;
  messages: ChatMessage[];
  /** Every tool call the agent made in this session, in call order. */
  toolEvents: readonly ChatToolEvent[];
  isResponding: boolean;
  send: (message: string) => void;
  stop: () => void;
  reset: () => void;
};

/**
 * `useAgentChat`'s options with the readonly modifiers dropped. `sessionId` and `onSessionIdChange`
 * are each passed only when supplied, and the SDK distinguishes an absent key from an explicit
 * `undefined`, so the object is assembled key by key rather than spread in one expression.
 */
type AgentChatOptions = Parameters<UseAgentChatHook>[0];
type MutableAgentChatOptions = { -readonly [K in keyof AgentChatOptions]: AgentChatOptions[K] };

export function useChat({ sessionId, onSessionIdChange }: UseChatOptions = {}): UseChatResult {
  // The SDK treats `sessionId: undefined` as "own it for me" and any explicit value as controlled,
  // so an omitted `sessionId` has to stay absent for the hook to remain uncontrolled.
  // This context value is an injectable hook implementation and is called unconditionally.
  // oxlint-disable-next-line react/hooks
  const useAgentChat = useContext(ChatTransportContext);
  const options: MutableAgentChatOptions = { agent: CHAT_AGENT };
  if (sessionId !== undefined) options.sessionId = sessionId;
  if (onSessionIdChange) options.onSessionIdChange = onSessionIdChange;
  // oxlint-disable-next-line react/hooks
  const chat = useAgentChat(options);

  // The prompt just sent, shown optimistically until the server's event history echoes it back. A
  // new session has no history to project from between `sendMessage` and the first frame, so the
  // question would otherwise flash absent. It waits for this exact prompt to echo, because from the
  // second turn the thread already holds the previous prompt.
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const echoed = useMemo(
    () =>
      pendingUser !== null && chat.messages.some((message) => isUserSaying(message, pendingUser)),
    [chat.messages, pendingUser],
  );
  useEffect(() => {
    // The echo is an external transport acknowledgement that completes the optimistic state.
    // oxlint-disable-next-line react/set-state-in-effect
    if (echoed) setPendingUser(null);
  }, [echoed]);

  // `chat.isLoading` drops to false twice mid-turn, and each dip blinked the thinking indicator out:
  // once when a new session id re-attaches the SDK, and once when the SDK projects `ready` between
  // the prompt landing and the answer's first entry. So the turn, not the transport, decides. The
  // hold runs from `send` until an assistant message settles after this prompt. It tracks the
  // prompt, not a boolean, because the previous turn's answer is already settled.
  const [awaitingAnswerTo, setAwaitingAnswerTo] = useState<string | null>(null);
  const answerArrived = useMemo(
    () => awaitingAnswerTo !== null && hasAnswerAfter(chat.messages, awaitingAnswerTo),
    [chat.messages, awaitingAnswerTo],
  );
  useEffect(() => {
    // A settled answer or transport error completes the locally held turn.
    // oxlint-disable-next-line react/set-state-in-effect
    if (answerArrived || chat.error) setAwaitingAnswerTo(null);
  }, [answerArrived, chat.error]);

  const isResponding = chat.isLoading || awaitingAnswerTo !== null;

  const chatRef = useRef(chat);
  // Stable callbacks must see the transport selected by this render, before passive effects run.
  // oxlint-disable-next-line react/refs
  chatRef.current = chat;
  const send = useCallback((draft: string) => {
    const text = draft.trim();
    if (!text) return;
    setPendingUser(text);
    setAwaitingAnswerTo(text);
    // The hook records the failure on `chat.error`; swallow the rejection so it is not unhandled.
    void chatRef.current.sendMessage(text).catch(() => undefined);
  }, []);

  const stop = useCallback(() => void chatRef.current.stop(), []);
  const reset = useCallback(() => {
    setPendingUser(null);
    setAwaitingAnswerTo(null);
    chatRef.current.reset();
  }, []);

  const messages = useMemo<ChatMessage[]>(() => {
    const raw = chat.messages.flatMap(toChatMessage);

    // Same test as the hold above, because for one frame after the echo lands both this and the
    // real bubble would otherwise be on screen.
    if (
      pendingUser &&
      !raw.some((message) => message.role === "user" && message.content === pendingUser)
    ) {
      raw.push({ id: "pending-user", role: "user", content: pendingUser, animateIn: true });
    }

    const last = raw.at(-1);
    const assistantStillStreaming = last?.role === "assistant" && last.pending === true;
    // A turn that already produced an answer is not a failed turn, whatever the session's
    // terminal state says. The control plane can mark a session `failed` AFTER streaming a
    // complete answer, with the answer itself as the error string — rendering that would show
    // the same reply a second time, in red, as though it were the failure.
    const answered = last?.role === "assistant" && last.pending !== true && last.error !== true;
    if (chat.error && !assistantStillStreaming && !answered) {
      raw.push({
        id: "turn-error",
        role: "assistant",
        content: chat.error.message || FAILURE_FALLBACK,
        error: true,
      });
    } else if (isResponding && !assistantStillStreaming) {
      raw.push({ id: "pending-assistant", role: "assistant", content: "", pending: true });
    }

    // Last line of defence for the React key. Two rows sharing an id make React drop one of
    // them silently ("may cause children to be duplicated and/or omitted"), which is a worse
    // failure than the duplicate itself because it is invisible. The cause is upstream — a
    // stream that resumes from the start re-applies history and the reducer's `add` inserts
    // rather than overwrites — so this only guarantees the thread stays renderable.
    const seen = new Set<string>();
    return raw.filter((message) => {
      if (seen.has(message.id)) return false;
      seen.add(message.id);
      return true;
    });
  }, [chat.messages, chat.error, isResponding, pendingUser]);

  const toolEvents = useMemo(() => toToolEvents(chat.events), [chat.events]);

  return {
    sessionId: chat.sessionId,
    messages,
    toolEvents,
    isResponding,
    send,
    stop,
    reset,
  };
}

/**
 * Whether an assistant message has settled since `prompt` was asked.
 *
 * Scans back to the LAST time the prompt was asked, so repeating a question waits for its own answer.
 */
function hasAnswerAfter(messages: readonly AgentMessage[], prompt: string): boolean {
  let askedAt = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (isUserSaying(messages[index]!, prompt)) {
      askedAt = index;
      break;
    }
  }
  if (askedAt === -1) return false;
  return messages
    .slice(askedAt + 1)
    .some((message) => message.role === "assistant" && message.status !== "streaming");
}

function isUserSaying(message: AgentMessage, text: string): boolean {
  return message.role === "user" && message.parts.map((part) => part.text).join("") === text;
}

/** The tool calls among the session's events (progress and alert events are not tool calls). */
function toToolEvents(events: readonly AgentEvent[]): ChatToolEvent[] {
  return events.flatMap((event) =>
    event.type === "tool" ? [{ id: event.id, name: event.name, status: event.status }] : [],
  );
}

function toChatMessage(message: AgentMessage): ChatMessage[] {
  if (message.role !== "user" && message.role !== "assistant") return [];
  return [
    {
      id: message.id,
      role: message.role,
      content: message.parts.map((part) => part.text).join(""),
      pending: message.status === "streaming",
    },
  ];
}
