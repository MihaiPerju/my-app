import "../../../test/setup.js";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";

import type { ChatSession } from "@/api/generated/types.gen";
import { client } from "@/api/generated/client.gen";

const API_ORIGIN = "http://api.test";
client.setConfig({ baseUrl: API_ORIGIN });

const SESSIONS_URL = `${API_ORIGIN}/api/v1/chat/sessions`;

const { ChatSessions } = await import("./chat-sessions");

const OLDEST_TITLE = "How do evals work?";
const NEWEST_TITLE = "Speech synthesis voices";

const OLDEST: ChatSession = {
  session_id: "11111111-1111-4111-8111-111111111111",
  status: "waiting",
  title: OLDEST_TITLE,
  created_at: "2026-07-01T09:00:00Z",
  updated_at: "2026-07-01T09:30:00Z",
};
const NEWEST: ChatSession = {
  session_id: "22222222-2222-4222-8222-222222222222",
  status: "running",
  title: NEWEST_TITLE,
  created_at: "2026-07-02T09:00:00Z",
  updated_at: "2026-07-02T11:00:00Z",
};
const UNTITLED: ChatSession = {
  session_id: "33333333-3333-4333-8333-333333333333",
  status: "waiting",
  title: null,
  created_at: "2026-06-30T09:00:00Z",
  updated_at: "2026-06-30T09:00:00Z",
};

function stubSessions(items: ChatSession[], options: { fail?: boolean } = {}) {
  // SAFETY: the app fetches sessions through the generated client, which calls `fetch(new
  // Request(...))`. This stub answers that one call shape; the cast supplies the rest of
  // `typeof fetch` the rail never reaches.
  globalThis.fetch = ((_input: string | URL | Request) => {
    if (options.fail) {
      return Promise.resolve(new Response("{}", { status: 500 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ items, next_cursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

/**
 * The rail under a real router, because everything under test is a `Link`: the search param it
 * writes and the param it reads back are the whole contract.
 */
async function rail(items: ChatSession[], initialEntry = "/chat") {
  const rootRoute = createRootRoute({ component: ChatSessions });
  const chatRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/chat",
    validateSearch: (search): { session?: string } => {
      const session = z.string().safeParse(search["session"]);
      return session.success ? { session: session.data } : {};
    },
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([chatRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    defaultPendingMinMs: 0,
  });

  await router.load();

  const screen = render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  if (items.length > 0) {
    await waitFor(() => expect(screen.getAllByRole("link").length).toBeGreaterThan(1));
  }

  return { screen, router };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
});

describe("the chats rail", () => {
  test("lists the caller's sessions newest activity first", async () => {
    stubSessions([OLDEST, NEWEST, UNTITLED]);
    const { screen } = await rail([OLDEST, NEWEST, UNTITLED]);

    // The rail's own "+" control is a link too, so select by what distinguishes a session row:
    // visible text. The icon button has none, only an `aria-label`.
    const titles = screen
      .getAllByRole("link")
      .map((link) => link.textContent)
      .filter((title) => title !== "");

    expect(titles).toEqual([NEWEST_TITLE, OLDEST_TITLE, "Untitled chat"]);
  });

  test("reads the list through the chat sessions endpoint", async () => {
    const urls: string[] = [];
    // SAFETY: this stub records the URL the generated client requests and answers the one
    // `fetch(new Request(...))` call it makes; the cast covers the unused rest of `typeof fetch`.
    globalThis.fetch = ((input: string | URL | Request) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return Promise.resolve(
        new Response(JSON.stringify({ items: [NEWEST], next_cursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;

    await rail([NEWEST]);

    expect(urls).toEqual([SESSIONS_URL]);
  });

  test("clicking a chat navigates to it by search param", async () => {
    stubSessions([NEWEST]);
    const { screen, router } = await rail([NEWEST]);

    fireEvent.click(screen.getByRole("link", { name: NEWEST_TITLE }));

    await waitFor(() =>
      expect(router.state.location.search).toEqual({ session: NEWEST.session_id }),
    );
  });

  test("marks the session the URL names, and only that one", async () => {
    stubSessions([OLDEST, NEWEST]);
    const { screen } = await rail([OLDEST, NEWEST], `/chat?session=${NEWEST.session_id}`);

    const active = screen.getByRole("link", { name: NEWEST_TITLE });
    const inactive = screen.getByRole("link", { name: OLDEST_TITLE });

    expect(active.getAttribute("data-active")).toBe("true");
    expect(active.getAttribute("aria-current")).toBe("page");
    expect(inactive.getAttribute("data-active")).toBe("false");
    expect(inactive.hasAttribute("aria-current")).toBe(false);
  });

  test("the rail's own new-chat control clears the selected session from the URL", async () => {
    stubSessions([NEWEST]);
    const { screen, router } = await rail([NEWEST], `/chat?session=${NEWEST.session_id}`);

    fireEvent.click(screen.getByRole("link", { name: "Start a new chat" }));

    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });

  test("says so when there is nothing to list", async () => {
    stubSessions([]);
    const { screen } = await rail([]);

    await waitFor(() => expect(screen.getByText("No chats yet.")).toBeTruthy());
  });

  test("says so when the list cannot be read", async () => {
    stubSessions([], { fail: true });
    const { screen } = await rail([]);

    await waitFor(() => expect(screen.getByText("Could not load your chats.")).toBeTruthy());
  });
});
