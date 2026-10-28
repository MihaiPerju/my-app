import "../../test/setup.js";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import type { ChatSession } from "@/api/generated/types.gen";
import { client } from "@/api/generated/client.gen";

const API_ORIGIN = "http://api.test";
client.setConfig({ baseUrl: API_ORIGIN });

const { useRefreshSessions, useSessions } = await import("./use-sessions");

// The production client's, deliberately: without it a refetch could be explained by staleness
// alone, and the assertion below would pass whether or not the invalidation happened.
const STALE_TIME_MS = 60_000;

function session(title: string): ChatSession {
  return {
    session_id: "11111111-1111-4111-8111-111111111111",
    status: "waiting",
    title,
    created_at: "2026-07-01T09:00:00Z",
    updated_at: "2026-07-01T09:30:00Z",
  };
}

const NOT_MOUNTED_YET = () => {};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
});

describe("the chats rail's freshness", () => {
  test("a conversation created after the list was fetched still reaches the rail", async () => {
    let items = [session("How do evals work?")];
    // SAFETY: the rail reads sessions through the generated client's `fetch(new Request(...))`;
    // this stub serves that one call from the captured `items`. The cast covers the rest of
    // `typeof fetch`, none of which this test touches.
    globalThis.fetch = ((_input: string | URL | Request) =>
      Promise.resolve(
        new Response(JSON.stringify({ items, next_cursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )) as typeof fetch;

    let refresh: () => void = NOT_MOUNTED_YET;
    function Rail() {
      // This assignment deliberately exposes the hook callback to the test harness.
      // oxlint-disable-next-line react/globals
      refresh = useRefreshSessions();
      const sessions = useSessions();
      return <div>{(sessions.data ?? []).map((row) => row.title).join(",")}</div>;
    }

    const screen = render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { staleTime: STALE_TIME_MS } } })}
      >
        <Rail />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText("How do evals work?")).toBeTruthy());

    // What the chat SDK does behind this query's back when the user sends a first message.
    items = [session("Transcribe an audio file"), ...items];
    await act(async () => refresh());

    await waitFor(() =>
      expect(screen.getByText("Transcribe an audio file,How do evals work?")).toBeTruthy(),
    );
  });
});
