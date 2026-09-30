// The wire shapes below mirror the OpenAPI-generated types one field for one field, and the
// parity guard in `apps/web/src/features/chat/contract-parity.test-d.ts` asserts the two are
// mutually assignable, so a server-side change that regenerates the client fails the type check
// here rather than drifting silently. `span_id` / `trace_id` are optional on purpose — the server
// deliberately does not invent them when absent — and widening them to required would break parity.

export type ChatSession = {
  created_at: string;
  session_id: string;
  status: string;
  title?: string | null;
  updated_at: string;
};

export type ChatSessionPage = {
  items: Array<ChatSession>;
  next_cursor?: string | null;
};

export type ChatFeedbackRequest = {
  message_id: string;
  rating: "up" | "down";
  session_id: string;
  span_id?: string | null;
  trace_id?: string | null;
};

/** One thumbs verdict on an answer. The `rating` half of `ChatFeedbackRequest`, named. */
export type MessageRating = "up" | "down";

export type TranscribeAudioOptions = {
  fileName?: string;
  language?: string;
  signal?: AbortSignal;
};

export type ChatMessageRole = "assistant" | "user";

export type ChatMessage = {
  id: string;
  role: ChatMessageRole;
  content: string;
  // The assistant bubble is `pending` while the answer is still generating (drives the thinking
  // indicator); `error` styles a failed turn.
  pending?: boolean;
  error?: boolean;
  // Only ever set for a just-sent prompt, which is the one case that animates in.
  animateIn?: boolean;
};

/**
 * One tool call the agent made during the session, as the transport projects it: the tool's name
 * and where the call stands. Arguments and results are not part of the session's public event
 * stream, so a consumer that needs them reads them from the tool's own surface.
 */
export type ChatToolEvent = {
  id: string;
  name: string;
  status: "running" | "completed" | "failed" | "canceled";
};

/**
 * What chat shares with the side app open beside it, read with `useChatContext()` from anywhere
 * under the chat layout route: the rendered transcript, every tool call the agent has made in this
 * session (in call order), the session id, whether a turn is still in flight, and the live tool
 * event that opened the side app. A side app that does not care never reads it.
 */
export type ChatContextValue = {
  messages: readonly ChatMessage[];
  toolEvents: readonly ChatToolEvent[];
  sessionId: string | null;
  isResponding: boolean;
  /**
   * The tool call, made during a turn sent from the chat page, whose name the side app declares in
   * `staticData.chatApp.tools` and which opened it. Absent when the side app was opened by hand,
   * and on a history entry revisited after a reload.
   */
  openedBy?: ChatToolEvent;
};
