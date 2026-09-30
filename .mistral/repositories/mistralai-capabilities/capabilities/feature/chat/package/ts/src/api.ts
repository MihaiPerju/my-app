import type { ChatFeedbackRequest, ChatSession, TranscribeAudioOptions } from "./types";

// Declared as function-typed PROPERTIES, not method shorthand. Each hook in `./web` is injected
// one member on its own — `useSessions(chatApi.listSessions)` — so the members must be detachable
// plain functions rather than methods carrying a `this`, which is what the property form states
// and `typescript(unbound-method)` enforces. It also checks parameters contravariantly, where
// method shorthand would accept a bivariant (unsound) implementation.
export interface ChatApi {
  listSessions: () => Promise<ChatSession[]>;
  submitFeedback: (request: ChatFeedbackRequest) => Promise<void>;
  // Optional: dictation and read-aloud are contributed by whichever capability serves speech. The
  // composer's mic and an answer's read-aloud action are offered only when these are present.
  transcribeAudio?: (audio: Blob, options?: TranscribeAudioOptions) => Promise<string>;
  synthesizeSpeech?: (text: string, options?: { signal?: AbortSignal }) => Promise<string>;
}
