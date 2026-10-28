import type { ChatApi } from "@mistralai-capabilities/feature-chat";

import { chatListSessions, chatSubmitFeedback } from "@/api/generated/sdk.gen";
import { unwrap } from "@/api/unwrap";

// The chat turn no longer lives here. It runs through the `@mistral/workflow-ui` SDK's
// `useAgentChat`, which owns the `/api/v1/chat/*` transport. What remains is chat's own two routes.
// Dictation and read-aloud are not chat's: a capability contributes them as a chat extension
// (`./extensions/`), merged in by `ChatApiProvider`.

export const chatApi: ChatApi = {
  // The list is the sidebar's own surface. The vendored chat SDK has no list method, so it goes
  // through the generated client like every other route. `next_cursor` is carried but not
  // followed: the rail shows the first page, like the old conversations list, which had no paging.
  listSessions: () => unwrap(chatListSessions({ throwOnError: true })).then((page) => page.items),

  /**
   * Records one thumbs verdict against an answer. Fire-and-forget telemetry: nothing stores or
   * reads it back, so the vote lives only in this session's state and the write is never awaited.
   */
  submitFeedback: async (request) => {
    await unwrap(chatSubmitFeedback({ body: request, throwOnError: true }));
  },
};
