import type { AgentEvent, AgentMessage } from "@mistral/workflow-ui/agents";
import type { UseAgentChatResult } from "@mistral/workflow-ui/agents/react";
import { act } from "@testing-library/react";
import { useEffect, useState } from "react";

// A controllable stand-in for the vendored SDK's `useAgentChat`. The chat feature's own code is
// the adapter (`use-chat`) and the UI on top of it; the SDK's transport and reducer are vendored,
// READ-ONLY, and covered by the SDK's own tests. So the tests drive this hook's snapshot directly
// rather than stubbing the `/api/v1/chat/*` wire — the boundary under test is the mapping.

type Status = "ready" | "submitted" | "streaming" | "error";

type Snapshot = {
  sessionId: string | null;
  messages: AgentMessage[];
  events: AgentEvent[];
  status: Status;
  error: Error | null;
};

const INITIAL: Snapshot = {
  sessionId: null,
  messages: [],
  events: [],
  status: "ready",
  error: null,
};

let snapshot: Snapshot = { ...INITIAL };
const setters = new Set<(next: Snapshot) => void>();
const prompts: string[] = [];
let stopped = 0;
let resets = 0;
/** The mounted chat's `onSessionIdChange`, called by `mintSession` as the SDK does. */
let reportSessionId: ((sessionId: string | null) => void) | undefined;

export function resetAgentChat(): void {
  snapshot = { ...INITIAL };
  prompts.length = 0;
  stopped = 0;
  resets = 0;
  for (const set of setters) set(snapshot);
}

export function setAgentChat(patch: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...patch };
  act(() => {
    for (const set of setters) set(snapshot);
  });
}

/**
 * The SDK naming a new chat on its first turn. As with a controlled session, the page is told
 * first and the id follows: `useAgentChat` reports it through `onSessionIdChange`, and only then
 * does the caller's `sessionId` change.
 */
export function mintSession(sessionId: string): void {
  act(() => reportSessionId?.(sessionId));
  setAgentChat({ sessionId });
}

export function sentPrompts(): string[] {
  return [...prompts];
}

export function stopCount(): number {
  return stopped;
}

export function resetCount(): number {
  return resets;
}

export function textMessage(
  id: string,
  role: AgentMessage["role"],
  text: string,
  status: AgentMessage["status"] = "complete",
): AgentMessage {
  return { id, role, parts: [{ type: "text", text }], status };
}

export function useAgentChatMock(options?: {
  onSessionIdChange?: (sessionId: string | null) => void;
}): UseAgentChatResult {
  const [state, setState] = useState(snapshot);
  const onSessionIdChange = options?.onSessionIdChange;
  useEffect(() => {
    reportSessionId = onSessionIdChange;
  }, [onSessionIdChange]);
  useEffect(() => {
    setters.add(setState);
    // Synchronize a newly mounted test subscriber with the current external mock snapshot.
    // oxlint-disable-next-line react/set-state-in-effect
    setState(snapshot);
    return () => {
      setters.delete(setState);
    };
  }, []);

  return {
    sessionId: state.sessionId,
    messages: state.messages,
    events: state.events,
    status: state.status,
    isLoading: state.status === "submitted" || state.status === "streaming",
    error: state.error,
    sendMessage: async (message: string) => {
      prompts.push(message);
    },
    stop: async () => {
      stopped += 1;
    },
    reset: () => {
      resets += 1;
    },
  };
}
