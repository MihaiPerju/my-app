import "../../test/setup.js";

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";

import {
  resetAgentChat,
  sentPrompts,
  setAgentChat,
  textMessage,
  useAgentChatMock,
} from "../../test/agent-chat-mock";
import { ChatRuntimeProvider } from "./chat-runtime";
import { useChat } from "./use-chat";

const wrapper = ({ children }: { children: ReactNode }) => (
  <ChatRuntimeProvider transport={{ useAgentChat: useAgentChatMock }}>
    {children}
  </ChatRuntimeProvider>
);

beforeEach(() => resetAgentChat());
afterEach(cleanup);

/**
 * `ChatThread` compares bubble fields at its memo boundary, so the mapper may produce fresh objects
 * while preserving the observable conversation and avoiding repeated markdown work.
 */
describe("useChat snapshot mapping", () => {
  test("maps the SDK's snapshot messages onto chat bubbles, last-write-wins", () => {
    const { result } = renderHook(() => useChat(), { wrapper });

    setAgentChat({
      status: "streaming",
      messages: [
        textMessage("u-1", "user", "How do evals work?"),
        textMessage("a-1", "assistant", "Routing", "streaming"),
      ],
    });

    expect(result.current.messages.map((message) => message.content)).toEqual([
      "How do evals work?",
      "Routing",
    ]);

    setAgentChat({
      status: "ready",
      messages: [
        textMessage("u-1", "user", "How do evals work?"),
        textMessage("a-1", "assistant", "Routing to evals."),
      ],
    });

    // The assistant snapshot is replaced, not appended.
    expect(result.current.messages.at(-1)?.content).toBe("Routing to evals.");
    expect(result.current.isResponding).toBe(false);
  });

  test("keeps a settled bubble unchanged across the next turn's frames", () => {
    const { result } = renderHook(() => useChat(), { wrapper });

    setAgentChat({
      status: "ready",
      messages: [
        textMessage("u-1", "user", "First question"),
        textMessage("a-1", "assistant", "First answer."),
      ],
    });
    const settled = result.current.messages.at(-1);

    setAgentChat({
      status: "streaming",
      messages: [
        textMessage("u-1", "user", "First question"),
        textMessage("a-1", "assistant", "First answer."),
        textMessage("u-2", "user", "Second question"),
        textMessage("a-2", "assistant", "partial", "streaming"),
      ],
    });

    expect(result.current.messages[1]).toEqual(settled);
  });

  test("keeps send, stop and reset stable across frames", () => {
    const { result } = renderHook(() => useChat(), { wrapper });
    const { send, stop, reset } = result.current;

    setAgentChat({
      status: "streaming",
      messages: [textMessage("a-1", "assistant", "x", "streaming")],
    });
    setAgentChat({
      status: "streaming",
      messages: [textMessage("a-1", "assistant", "xy", "streaming")],
    });

    expect(result.current.send).toBe(send);
    expect(result.current.stop).toBe(stop);
    expect(result.current.reset).toBe(reset);
  });

  test("shows the just-sent prompt optimistically before the server echoes it", () => {
    const { result } = renderHook(() => useChat(), { wrapper });

    result.current.send("Tell me something");

    // No SDK message yet, but the question and a pending assistant bubble are already on screen.
    setAgentChat({ status: "submitted", messages: [] });
    expect(result.current.messages.map((message) => message.content)).toEqual([
      "Tell me something",
      "",
    ]);
    expect(result.current.messages.at(-1)?.pending).toBe(true);
    expect(sentPrompts()).toEqual(["Tell me something"]);
  });
  test("a session that failed after answering does not repeat the answer in red", () => {
    // The control plane can mark a session `failed` once the answer is already complete, with
    // the answer itself as the error string. Rendering that shows the same reply twice, the
    // second copy styled as the failure.
    const { result } = renderHook(() => useChat(), { wrapper });

    setAgentChat({
      status: "error",
      messages: [
        textMessage("u-1", "user", "Which voices are available?"),
        textMessage("a-1", "assistant", "Here are the available voices."),
      ],
      error: new Error("Here are the available voices."),
    });

    expect(result.current.messages.map((message) => message.content)).toEqual([
      "Which voices are available?",
      "Here are the available voices.",
    ]);
    expect(result.current.messages.some((message) => message.error)).toBe(false);
  });

  test("a turn that failed with no answer still surfaces the error", () => {
    const { result } = renderHook(() => useChat(), { wrapper });

    setAgentChat({
      status: "error",
      messages: [textMessage("u-1", "user", "Which voices are available?")],
      error: new Error("The agent control plane is unavailable"),
    });

    expect(result.current.messages.at(-1)?.error).toBe(true);
    expect(result.current.messages.at(-1)?.content).toBe("The agent control plane is unavailable");
  });

  test("two snapshot messages sharing an id render once, not as a colliding key", () => {
    // React drops one of two children sharing a key and only warns, so the duplicate is
    // invisible until the thread misbehaves. Collapsing here keeps it renderable.
    const { result } = renderHook(() => useChat(), { wrapper });

    setAgentChat({
      status: "ready",
      messages: [
        textMessage("u-1", "user", "Which voices are available?"),
        textMessage("a-1", "assistant", "Here are the available voices."),
        textMessage("u-1", "user", "Which voices are available?"),
      ],
    });

    expect(result.current.messages.map((message) => message.id)).toEqual(["u-1", "a-1"]);
  });
  test("the thinking indicator survives the session id arriving", () => {
    // Opening a chat mints a session id, which this app puts in the URL; the id coming back as a
    // prop makes the SDK re-attach, and re-attaching RESETS its state to empty before it refetches.
    // Across those two round trips the SDK reports nothing loading, so without an optimistic hold
    // the indicator blinks out for about a second mid-turn.
    const { result } = renderHook(() => useChat(), { wrapper });

    result.current.send("Blink test");
    setAgentChat({ status: "submitted", messages: [] });
    expect(result.current.isResponding).toBe(true);

    // The SDK's reset: state wiped, status back to ready, nothing in flight as far as it knows.
    setAgentChat({ status: "ready", messages: [] });

    expect(result.current.isResponding).toBe(true);
    expect(result.current.messages.at(-1)?.pending).toBe(true);
  });

  test("the hold is released once the SDK has re-attached", () => {
    const { result } = renderHook(() => useChat(), { wrapper });

    result.current.send("Blink test");
    setAgentChat({ status: "ready", messages: [] });
    expect(result.current.isResponding).toBe(true);

    setAgentChat({
      status: "ready",
      messages: [
        textMessage("u-1", "user", "Blink test"),
        textMessage("a-1", "assistant", "Done."),
      ],
    });

    expect(result.current.isResponding).toBe(false);
    expect(result.current.messages.some((message) => message.pending)).toBe(false);
  });

  test("the previous turn's answer does not release the new turn's hold", () => {
    // The design point: the hold tracks the prompt, not a boolean. Turn one's answer is already
    // settled when turn two is sent, so a boolean would be released on the very next frame.
    const { result } = renderHook(() => useChat(), { wrapper });

    const settledFirstTurn = [
      textMessage("u-1", "user", "First"),
      textMessage("a-1", "assistant", "Answer."),
    ];
    setAgentChat({ sessionId: "s-1", status: "ready", messages: settledFirstTurn });
    result.current.send("Second");

    // The dip: the SDK projects `ready` between the prompt landing and the answer starting.
    setAgentChat({
      sessionId: "s-1",
      status: "ready",
      messages: [...settledFirstTurn, textMessage("u-2", "user", "Second")],
    });

    expect(result.current.isResponding).toBe(true);
    expect(result.current.messages.at(-1)?.pending).toBe(true);
  });

  test("the hold releases when THIS turn's answer settles", () => {
    const { result } = renderHook(() => useChat(), { wrapper });

    const settledFirstTurn = [
      textMessage("u-1", "user", "First"),
      textMessage("a-1", "assistant", "Answer."),
    ];
    setAgentChat({ sessionId: "s-1", status: "ready", messages: settledFirstTurn });
    result.current.send("Second");
    setAgentChat({
      sessionId: "s-1",
      status: "ready",
      messages: [...settledFirstTurn, textMessage("u-2", "user", "Second")],
    });
    expect(result.current.isResponding).toBe(true);

    setAgentChat({
      sessionId: "s-1",
      status: "ready",
      messages: [
        ...settledFirstTurn,
        textMessage("u-2", "user", "Second"),
        textMessage("a-2", "assistant", "Second answer."),
      ],
    });

    expect(result.current.isResponding).toBe(false);
    expect(result.current.messages.some((message) => message.pending)).toBe(false);
  });

  test("the second turn's prompt shows immediately, not only once the server echoes it", () => {
    // The thread already holds the FIRST turn's user message, so a test for "any user message"
    // is true the moment the second prompt is sent and the bubble never renders.
    const { result } = renderHook(() => useChat(), { wrapper });

    setAgentChat({
      sessionId: "s-1",
      status: "ready",
      messages: [textMessage("u-1", "user", "First"), textMessage("a-1", "assistant", "Answer.")],
    });

    result.current.send("Second question");
    // The SDK's own frame for the send; it re-renders the hook so the optimistic row is applied.
    setAgentChat({
      sessionId: "s-1",
      status: "submitted",
      messages: [textMessage("u-1", "user", "First"), textMessage("a-1", "assistant", "Answer.")],
    });

    expect(result.current.messages.map((message) => message.content)).toEqual([
      "First",
      "Answer.",
      "Second question",
      "",
    ]);
  });

  test("the optimistic bubble is replaced by the echo, never shown twice", () => {
    const { result } = renderHook(() => useChat(), { wrapper });

    setAgentChat({
      sessionId: "s-1",
      status: "ready",
      messages: [textMessage("u-1", "user", "First")],
    });
    result.current.send("Second question");
    setAgentChat({
      sessionId: "s-1",
      status: "submitted",
      messages: [textMessage("u-1", "user", "First")],
    });
    expect(result.current.messages.filter((m) => m.content === "Second question")).toHaveLength(1);

    setAgentChat({
      sessionId: "s-1",
      status: "streaming",
      messages: [
        textMessage("u-1", "user", "First"),
        textMessage("u-2", "user", "Second question"),
        textMessage("a-2", "assistant", "Wor", "streaming"),
      ],
    });

    expect(result.current.messages.filter((m) => m.content === "Second question")).toHaveLength(1);
    expect(result.current.messages.map((m) => m.id)).toEqual(["u-1", "u-2", "a-2"]);
  });
});

describe("useChat tool events", () => {
  // A split-panel app reacts to what the agent did, so the tool calls must survive the mapping
  // rather than being dropped with everything that is not message text.
  test("surfaces the session's tool calls and nothing else", () => {
    const { result } = renderHook(() => useChat(), { wrapper });

    setAgentChat({
      status: "streaming",
      events: [
        { id: "p-1", type: "progress", status: "started", title: "Thinking", message: "" },
        { id: "t-1", type: "tool", name: "search_search", status: "completed" },
        { id: "t-2", type: "tool", name: "ontology_traverse", status: "running" },
      ],
    });

    expect(result.current.toolEvents).toEqual([
      { id: "t-1", name: "search_search", status: "completed" },
      { id: "t-2", name: "ontology_traverse", status: "running" },
    ]);
  });
});
