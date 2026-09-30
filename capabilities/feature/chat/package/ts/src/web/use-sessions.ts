import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useCallback } from "react";

import type { ChatApi } from "../api";
import type { ChatSession } from "../types";

const SESSIONS_KEY = ["chat", "sessions"] as const;

export function useSessions(listSessions: ChatApi["listSessions"]): UseQueryResult<ChatSession[]> {
  return useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: () => listSessions(),
  });
}

/**
 * Puts a just-created conversation in the rail.
 *
 * Nothing else can. The chat SDK opens the session over its own transport, so this query never
 * observes it. The shared client's 60s `staleTime` means even remounting the sidebar keeps serving
 * the page fetched before the session existed.
 */
export function useRefreshSessions(): () => void {
  const queryClient = useQueryClient();
  return useCallback(
    () => void queryClient.invalidateQueries({ queryKey: SESSIONS_KEY }),
    [queryClient],
  );
}
