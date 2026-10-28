import { useFeedback as useFeedbackBase } from "@mistralai-capabilities/feature-chat/web";

import { chatApi } from "./api";

export type { UseFeedbackResult } from "@mistralai-capabilities/feature-chat/web";

export function useFeedback(sessionId: string | null) {
  return useFeedbackBase(chatApi.submitFeedback, sessionId);
}
