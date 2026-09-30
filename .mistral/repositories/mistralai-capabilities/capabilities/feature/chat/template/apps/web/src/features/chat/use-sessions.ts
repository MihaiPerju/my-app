import { useSessions as useSessionsBase } from "@mistralai-capabilities/feature-chat/web";

import { chatApi } from "./api";

export type { ChatSession } from "@mistralai-capabilities/feature-chat";
export { useRefreshSessions } from "@mistralai-capabilities/feature-chat/web";

export function useSessions() {
  return useSessionsBase(chatApi.listSessions);
}
