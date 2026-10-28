import "../../../test/setup.js";

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import { client } from "@/api/generated/client.gen";
import { ChatApiProvider, type ChatExtension } from "../chat-api";
import type { ChatMessage } from "../use-chat";

// jsdom has no layout engine, so the thread's scroll affordances are no-ops here.
globalThis.HTMLElement.prototype.scrollIntoView = () => {};

const API_ORIGIN = "http://api.test";
client.setConfig({ baseUrl: API_ORIGIN });

const FEEDBACK_URL = `${API_ORIGIN}/api/v1/chat/feedback`;
const SESSION_ID = "session-1";
const ANSWER_ID = "m2-assistant";

/** Read-aloud is a chat extension; this one is never clicked, only shown. */
const readAloud: ChatExtension = { synthesizeSpeech: () => Promise.resolve("") };

const { ChatThread } = await import("./chat-thread");

/** The generated client sends a `Request`, so the body has to be read off it, not off `init`. */
type Written = { url: string; method: string; body: Promise<string> };

/** Records every feedback call and answers 204, the status the route returns. */
function stubFeedback() {
  const written: Written[] = [];
  // SAFETY: the generated client only ever calls `fetch(new Request(...))`; this stub covers that
  // one call shape and returns a real `Response`. The cast supplies the extra members of
  // `typeof fetch` (e.g. `preconnect`) that nothing under test touches.
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    written.push({ url: request.url, method: request.method, body: request.clone().text() });
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;
  return written;
}

type FeedbackBody = { session_id: string; message_id: string; rating: string };

async function sentBody(written: Written[], index: number): Promise<FeedbackBody> {
  return JSON.parse((await written[index]?.body) || "null");
}

function answered(overrides: Partial<ChatMessage> = {}): ChatMessage[] {
  return [
    { id: "m1-user", role: "user", content: "How do evals work?" },
    { id: ANSWER_ID, role: "assistant", content: "Through evaluators.", ...overrides },
  ];
}

function thread(messages: ChatMessage[], sessionId: string | null = SESSION_ID) {
  // With read-aloud installed, so every answer action is on screen.
  return render(
    <ChatApiProvider extensions={readAloud}>
      <ChatThread messages={messages} sessionId={sessionId} />
    </ChatApiProvider>,
  );
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
});

describe("assistant message feedback", () => {
  test("a thumbs up lights only that thumb and posts the vote", async () => {
    const written = stubFeedback();
    const screen = thread(answered());

    fireEvent.click(screen.getByLabelText("Good response"));

    expect(screen.getByLabelText("Good response").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("Bad response").getAttribute("aria-pressed")).toBe("false");

    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]?.method).toBe("POST");
    expect(written[0]?.url).toBe(FEEDBACK_URL);
    expect(await sentBody(written, 0)).toEqual({
      session_id: SESSION_ID,
      message_id: ANSWER_ID,
      rating: "up",
    });
  });

  test("choosing the other thumb replaces the first rather than lighting both", () => {
    stubFeedback();
    const screen = thread(answered());

    fireEvent.click(screen.getByLabelText("Good response"));
    fireEvent.click(screen.getByLabelText("Bad response"));

    expect(screen.getByLabelText("Bad response").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("Good response").getAttribute("aria-pressed")).toBe("false");
  });

  test("pressing the lit thumb again withdraws the rating", () => {
    stubFeedback();
    const screen = thread(answered());

    fireEvent.click(screen.getByLabelText("Good response"));
    fireEvent.click(screen.getByLabelText("Good response"));

    expect(screen.getByLabelText("Good response").getAttribute("aria-pressed")).toBe("false");
  });

  test("withdrawing a rating sends nothing", async () => {
    // The vote is an append-only evaluation event with no retraction, so re-posting the rating
    // being taken back would count it twice in Studio.
    const written = stubFeedback();
    const screen = thread(answered());

    fireEvent.click(screen.getByLabelText("Good response"));
    await waitFor(() => expect(written).toHaveLength(1));

    fireEvent.click(screen.getByLabelText("Good response"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(written).toHaveLength(1);
  });

  test("a streaming answer is not ratable", () => {
    stubFeedback();
    const screen = thread(answered({ pending: true }));

    expect(screen.queryByLabelText("Good response")).toBeNull();
    expect(screen.queryByLabelText("Bad response")).toBeNull();
  });

  test("the error bubble is not ratable but keeps its other actions", () => {
    stubFeedback();
    const screen = thread([
      { id: "turn-error", role: "assistant", content: "failed", error: true },
    ]);

    expect(screen.queryByLabelText("Good response")).toBeNull();
    expect(screen.getByLabelText("Copy")).toBeTruthy();
  });

  test("the thumbs are disabled until a session exists", () => {
    stubFeedback();
    const screen = thread(answered(), null);

    expect(screen.getByLabelText("Good response").hasAttribute("disabled")).toBe(true);
    expect(screen.getByLabelText("Bad response").hasAttribute("disabled")).toBe(true);
  });

  test("the one-shot actions are not announced as toggles", () => {
    stubFeedback();
    const screen = thread(answered());

    for (const label of ["Copy", "Read aloud"]) {
      expect(screen.getByLabelText(label).hasAttribute("aria-pressed")).toBe(false);
    }
  });
});
