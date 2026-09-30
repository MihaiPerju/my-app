import "../../../test/setup.js";

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseMarkdown } from "@mistral/markdown";

import {
  resetAgentChat,
  setAgentChat,
  textMessage,
  useAgentChatMock,
} from "../../../test/agent-chat-mock";
import { ChatRuntimeProvider } from "../chat-runtime";
import { ChatPage } from "./chat-page";

globalThis.HTMLElement.prototype.scrollIntoView = () => {};

/**
 * Counts markdown parses per answer text.
 *
 * Substituting `parseMarkdown` is the only honest way to measure this. The protected thing is the
 * parser run behind `MarkdownSurface`, and a re-render that never reaches it costs nothing. The
 * wrapper delegates to the real parser.
 */
const parses = new Map<string, number>();

const parseMarkdownCounting = (...args: Parameters<typeof parseMarkdown>) => {
  const [source] = args;
  parses.set(source, (parses.get(source) ?? 0) + 1);
  return parseMarkdown(...args);
};

const renderChatPage = () =>
  render(
    <ChatRuntimeProvider
      transport={{ useAgentChat: useAgentChatMock }}
      markdown={{ parseMarkdown: parseMarkdownCounting }}
    >
      <ChatPage />
    </ChatRuntimeProvider>,
  );

beforeEach(() => resetAgentChat());
afterEach(() => {
  parses.clear();
  cleanup();
});

/**
 * `ChatThread`'s memo boundary, measured rather than asserted about.
 *
 * The SDK re-projects the whole message list on every snapshot with fresh objects, so `use-chat`
 * must re-stabilize identity or every settled answer re-parses on each frame. This measures the
 * parse across a second streaming turn, which mints new objects for the first answer too.
 */
describe("a settled answer's markdown", () => {
  test("is parsed once, and not again when the next turn starts and ends", async () => {
    const screen = renderChatPage();

    setAgentChat({
      status: "ready",
      messages: [
        textMessage("u-1", "user", "First question"),
        textMessage("a-1", "assistant", "First answer."),
      ],
    });
    await waitFor(() => expect(screen.getByText("First answer.")).toBeTruthy());

    const settled = parses.get("First answer.") ?? 0;
    expect(settled).toBeGreaterThan(0);

    setAgentChat({
      status: "streaming",
      messages: [
        textMessage("u-1", "user", "First question"),
        textMessage("a-1", "assistant", "First answer."),
        textMessage("u-2", "user", "Second question"),
        textMessage("a-2", "assistant", "partial", "streaming"),
      ],
    });
    await waitFor(() => expect(screen.getByText("partial")).toBeTruthy());

    setAgentChat({
      status: "streaming",
      messages: [
        textMessage("u-1", "user", "First question"),
        textMessage("a-1", "assistant", "First answer."),
        textMessage("u-2", "user", "Second question"),
        textMessage("a-2", "assistant", "partial and then some", "streaming"),
      ],
    });
    await waitFor(() => expect(screen.getByText("partial and then some")).toBeTruthy());

    setAgentChat({
      status: "ready",
      messages: [
        textMessage("u-1", "user", "First question"),
        textMessage("a-1", "assistant", "First answer."),
        textMessage("u-2", "user", "Second question"),
        textMessage("a-2", "assistant", "Second answer."),
      ],
    });
    await waitFor(() => expect(screen.getByText("Second answer.")).toBeTruthy());

    expect(parses.get("First answer.")).toBe(settled);
  });
});
