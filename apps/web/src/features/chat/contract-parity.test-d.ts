import type {
  ChatFeedbackRequest,
  ChatSession,
  ChatSessionPage,
} from "@mistralai-capabilities/feature-chat";

import type {
  ChatFeedbackRequest as GeneratedChatFeedbackRequest,
  ChatSession as GeneratedChatSession,
  ChatSessionPage as GeneratedChatSessionPage,
} from "@/api/generated/types.gen";

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

export const chatSessionParity: MutuallyAssignable<ChatSession, GeneratedChatSession> = true;
export const chatSessionPageParity: MutuallyAssignable<ChatSessionPage, GeneratedChatSessionPage> =
  true;
export const chatFeedbackRequestParity: MutuallyAssignable<
  ChatFeedbackRequest,
  GeneratedChatFeedbackRequest
> = true;
