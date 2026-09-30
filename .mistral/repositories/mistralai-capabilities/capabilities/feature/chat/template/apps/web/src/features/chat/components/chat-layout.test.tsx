import "../../../test/setup.js";

import type { AgentEvent } from "@mistral/workflow-ui/agents";
import { NotePencilIcon } from "@phosphor-icons/react";
import type { HistoryState } from "@tanstack/history";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  mintSession,
  resetAgentChat,
  sentPrompts,
  setAgentChat,
  textMessage,
  useAgentChatMock,
} from "../../../test/agent-chat-mock";
import { useChatContext } from "../chat-context";
import { ChatRuntimeProvider } from "../chat-runtime";
import { ChatLayout } from "./chat-layout";

// jsdom has no layout engine, so the auto-scroll effect's scrollIntoView is a no-op here.
globalThis.HTMLElement.prototype.scrollIntoView = () => {};

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION = "22222222-2222-4222-8222-222222222222";

/** Sends a prompt from the composer, then streams the agent's tool calls for that turn. */
function agentCalls(screen: ReturnType<typeof render>, ...events: AgentEvent[]) {
  send(screen);
  setAgentChat({ status: "streaming", events });
}

function send(screen: ReturnType<typeof render>) {
  const composer = screen.getByLabelText("Chat message");
  fireEvent.change(composer, { target: { value: "Take a note" } });
  fireEvent.submit(composer.closest("form")!);
}

/** One tool call in the session's event stream, as the transport reports it. */
function toolCall(id: string, name: string): AgentEvent {
  return { type: "tool", id, name, status: "running" };
}

/** A side app of the fake chat layout below: shows what `useChatContext()` gives it. */
function NotesApp() {
  const { messages, sessionId, openedBy } = useChatContext();
  return (
    <div>
      <p>Notes app</p>
      <p data-testid="notes-messages">{messages.length}</p>
      <p data-testid="notes-session">{sessionId ?? "none"}</p>
      <p data-testid="notes-opened-by">{openedBy?.name ?? "by hand"}</p>
      <p data-testid="notes-opened-by-id">{openedBy?.id ?? ""}</p>
    </div>
  );
}

/**
 * A route tree shaped like the app's: a chat layout with an index child and one side app that
 * declares `staticData.chatApp`, and the side app's standalone page.
 */
async function mountChat(initialEntry = "/chat", initialState?: HistoryState) {
  // A `?session=` URL is a controlled session: the transport reports that id from the start.
  const controlledSession = new URL(initialEntry, "http://app.test").searchParams.get("session");
  if (controlledSession) setAgentChat({ sessionId: controlledSession });
  const rootRoute = createRootRoute({ component: Outlet });
  const chatRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/chat",
    validateSearch: (search): { session?: string } => {
      const session = z.string().safeParse(search["session"]);
      return session.success ? { session: session.data } : {};
    },
    component: function ChatRoute() {
      const { session } = chatRoute.useSearch();
      return <ChatLayout route={chatRoute} sessionId={session ?? null} />;
    },
  });
  const chatIndexRoute = createRoute({
    getParentRoute: () => chatRoute,
    path: "/",
    component: () => null,
  });
  const notesSideAppRoute = createRoute({
    getParentRoute: () => chatRoute,
    path: "/notes",
    staticData: {
      chatApp: { label: "Notes", icon: NotePencilIcon, tools: ["take_note"], fullscreen: "/notes" },
    },
    component: NotesApp,
  });
  const notesPageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/notes",
    component: () => <p>Notes fullscreen</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      chatRoute.addChildren([chatIndexRoute, notesSideAppRoute]),
      notesPageRoute,
    ]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    defaultPendingMinMs: 0,
  });
  await router.load();
  // History state as the browser restores it on a reload: present before the page ever ran.
  if (initialState)
    await router.navigate({ href: initialEntry, state: initialState, replace: true });

  const screen = render(
    <ChatRuntimeProvider transport={{ useAgentChat: useAgentChatMock }}>
      <RouterProvider router={router} />
    </ChatRuntimeProvider>,
  );
  await waitFor(() => expect(screen.getByLabelText("Chat message")).toBeTruthy());
  const go = async (to: string, search: Record<string, string> = {}) => {
    await act(() => router.navigate({ to, search }));
  };
  return { screen, router, go };
}

beforeEach(() => resetAgentChat());
afterEach(() => cleanup());

describe("chat side apps", () => {
  test("the composer's Apps menu lists the side apps in the route tree", async () => {
    const { screen, router } = await mountChat(`/chat?session=${SESSION}`);

    // Radix opens its menu on a primary-button pointerdown (jsdom has no PointerEvent, so a
    // MouseEvent carries the button), and its submenu on ArrowRight.
    fireEvent(
      screen.getByLabelText("Add"),
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
    );
    const apps = await waitFor(() => screen.getByText("Apps"));
    fireEvent.keyDown(apps, { key: "ArrowRight" });
    const notes = await waitFor(() => screen.getByRole("menuitem", { name: "Notes" }));
    fireEvent.click(notes);

    await waitFor(() => expect(router.state.location.pathname).toBe("/chat/notes"));
    expect(router.state.location.search).toEqual({ session: SESSION });
  });

  test("a side app opens beside the conversation, which stays mounted as it opens and closes", async () => {
    const { screen, router, go } = await mountChat();
    const composer = screen.getByLabelText("Chat message");
    fireEvent.change(composer, { target: { value: "half-typed draft" } });
    expect(screen.queryByText("Notes app")).toBeNull();

    await go("/chat/notes", { session: SESSION });
    await waitFor(() => expect(screen.getByText("Notes app")).toBeTruthy());
    expect(screen.getByRole("region", { name: "Notes" })).toBeTruthy();
    // The same element, still holding the draft: nothing above the composer remounted.
    expect(screen.getByLabelText("Chat message")).toBe(composer);

    fireEvent.click(screen.getByLabelText("Close panel"));
    await waitFor(() => expect(screen.queryByText("Notes app")).toBeNull());
    expect(router.state.location.pathname).toBe("/chat");
    expect(router.state.location.search).toEqual({ session: SESSION });
    expect(screen.getByLabelText("Chat message")).toBe(composer);
    expect(screen.getByDisplayValue("half-typed draft")).toBe(composer);
  });

  test("Open fullscreen goes to the side app's standalone page", async () => {
    const { screen, router } = await mountChat(`/chat/notes?session=${SESSION}`);

    fireEvent.click(await waitFor(() => screen.getByLabelText("Open fullscreen")));

    await waitFor(() => expect(router.state.location.pathname).toBe("/notes"));
    await waitFor(() => expect(screen.getByText("Notes fullscreen")).toBeTruthy());
  });

  test("a tool call the agent makes during the turn opens the side app that declares it", async () => {
    const { screen, router } = await mountChat(`/chat?session=${SESSION}`);

    agentCalls(screen, toolCall("t-1", "take_note"));

    await waitFor(() => expect(screen.getByText("Notes app")).toBeTruthy());
    expect(router.state.location.pathname).toBe("/chat/notes");
    expect(router.state.location.search).toEqual({ session: SESSION });
    expect(screen.getByTestId("notes-opened-by").textContent).toBe("take_note");
  });

  test("a namespaced tool call matches the bare tool name the side app declares", async () => {
    const { screen } = await mountChat(`/chat?session=${SESSION}`);

    agentCalls(screen, toolCall("t-1", "client.take_note"));

    await waitFor(() => expect(screen.getByText("Notes app")).toBeTruthy());
    expect(screen.getByTestId("notes-opened-by").textContent).toBe("client.take_note");
  });

  test("a tool call the side app does not declare opens nothing", async () => {
    const { screen, router } = await mountChat(`/chat?session=${SESSION}`);

    agentCalls(screen, toolCall("t-1", "search"));

    await waitFor(() => expect(sentPrompts()).toEqual(["Take a note"]));
    expect(router.state.location.pathname).toBe("/chat");
    expect(screen.queryByText("Notes app")).toBeNull();
  });

  test("tool calls replayed from a past session never open a side app", async () => {
    const { screen, router } = await mountChat(`/chat?session=${SESSION}`);

    setAgentChat({
      sessionId: SESSION,
      status: "ready",
      messages: [textMessage("u-1", "user", "Note this"), textMessage("a-1", "assistant", "Done.")],
      events: [toolCall("t-1", "take_note")],
    });
    await waitFor(() => expect(screen.getByText("Done.")).toBeTruthy());
    // The next turn starts: the history's call is not new, so it still opens nothing.
    agentCalls(screen);

    await waitFor(() => expect(sentPrompts()).toEqual(["Take a note"]));
    expect(router.state.location.pathname).toBe("/chat");
    expect(screen.queryByText("Notes app")).toBeNull();
  });

  test("a session reloaded mid-turn does not open side apps for the calls it replays", async () => {
    const { screen, router } = await mountChat(`/chat?session=${SESSION}`);

    // What a reload of a running session looks like: its history lands at once, still streaming.
    setAgentChat({
      sessionId: SESSION,
      status: "streaming",
      events: [toolCall("t-1", "take_note")],
    });

    await waitFor(() => expect(screen.getByLabelText("Stop generating")).toBeTruthy());
    expect(router.state.location.pathname).toBe("/chat");
    expect(screen.queryByText("Notes app")).toBeNull();
  });

  test("switching to a past session mid-turn does not open side apps for its history", async () => {
    const { screen, router } = await mountChat(`/chat?session=${SESSION}`);
    agentCalls(screen);

    // The user picks another conversation from the rail while this turn is still running.
    setAgentChat({
      sessionId: OTHER_SESSION,
      status: "streaming",
      events: [toolCall("t-9", "take_note")],
    });

    await waitFor(() => expect(sentPrompts()).toEqual(["Take a note"]));
    expect(router.state.location.pathname).toBe("/chat");
    expect(screen.queryByText("Notes app")).toBeNull();
  });

  test("a new chat's first turn stays live when the SDK names the session", async () => {
    const { screen, router } = await mountChat("/chat");

    send(screen);
    mintSession(SESSION);
    setAgentChat({ status: "streaming", events: [toolCall("t-1", "take_note")] });

    await waitFor(() => expect(screen.getByText("Notes app")).toBeTruthy());
    expect(router.state.location.pathname).toBe("/chat/notes");
  });

  test("a past session picked before a new chat is named does not replay into side apps", async () => {
    const { screen, router } = await mountChat("/chat");

    send(screen);
    // The rail's past session loads before the SDK names the new chat.
    setAgentChat({
      sessionId: OTHER_SESSION,
      status: "streaming",
      events: [toolCall("t-9", "take_note")],
    });

    await waitFor(() => expect(sentPrompts()).toEqual(["Take a note"]));
    expect(router.state.location.pathname).toBe("/chat");
    expect(screen.queryByText("Notes app")).toBeNull();
  });

  test("a session minted earlier is not exempt when the user returns to it mid-turn", async () => {
    const { screen, router } = await mountChat("/chat");
    send(screen);
    mintSession(SESSION);
    setAgentChat({
      status: "ready",
      messages: [
        textMessage("u-1", "user", "Take a note"),
        textMessage("a-1", "assistant", "Noted."),
      ],
    });
    await waitFor(() => expect(screen.getByText("Noted.")).toBeTruthy());

    // A turn in another conversation, then back to the first while that turn still runs.
    setAgentChat({ sessionId: OTHER_SESSION, messages: [], events: [] });
    send(screen);
    setAgentChat({ status: "streaming" });
    setAgentChat({ sessionId: SESSION, events: [toolCall("t-1", "take_note")] });

    await waitFor(() => expect(sentPrompts()).toEqual(["Take a note", "Take a note"]));
    expect(router.state.location.pathname).toBe("/chat");
    expect(screen.queryByText("Notes app")).toBeNull();
  });

  test("repeated calls to an open side app's tool do not stack history entries", async () => {
    const { screen, router } = await mountChat(`/chat?session=${SESSION}`);
    agentCalls(screen, toolCall("t-1", "take_note"));
    await waitFor(() => expect(screen.getByText("Notes app")).toBeTruthy());
    const depth = router.history.length;

    setAgentChat({ events: [toolCall("t-1", "take_note"), toolCall("t-2", "take_note")] });

    await waitFor(() => expect(screen.getByTestId("notes-opened-by-id").textContent).toBe("t-2"));
    expect(router.history.length).toBe(depth);
  });

  test("a reloaded entry does not credit the tool call that opened it before the reload", async () => {
    // The browser keeps history state across a reload; a fresh page must not trust it.
    const { screen } = await mountChat(`/chat/notes?session=${SESSION}`, {
      chatAppOpenedBy: { id: "t-1", name: "take_note", status: "completed" },
    });

    await waitFor(() => expect(screen.getByText("Notes app")).toBeTruthy());
    expect(screen.getByTestId("notes-opened-by").textContent).toBe("by hand");
  });

  test("a side app reopened by hand is not credited to the tool call that once opened it", async () => {
    const { screen, go } = await mountChat(`/chat?session=${SESSION}`);
    agentCalls(screen, toolCall("t-1", "take_note"));
    await waitFor(() =>
      expect(screen.getByTestId("notes-opened-by").textContent).toBe("take_note"),
    );

    fireEvent.click(screen.getByLabelText("Close panel"));
    await waitFor(() => expect(screen.queryByText("Notes app")).toBeNull());
    await go("/chat/notes", { session: SESSION });

    await waitFor(() => expect(screen.getByTestId("notes-opened-by").textContent).toBe("by hand"));
  });

  test("a side app reads the conversation beside it with useChatContext", async () => {
    const { screen } = await mountChat(`/chat/notes?session=${SESSION}`);

    setAgentChat({
      sessionId: SESSION,
      status: "ready",
      messages: [textMessage("u-1", "user", "Hello"), textMessage("a-1", "assistant", "Hi.")],
    });

    await waitFor(() => expect(screen.getByTestId("notes-messages").textContent).toBe("2"));
    expect(screen.getByTestId("notes-session").textContent).toBe(SESSION);
    expect(screen.getByTestId("notes-opened-by").textContent).toBe("by hand");
  });
});
