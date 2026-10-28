import "../../../test/setup.js";

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement, type HTMLAttributes, type ReactNode } from "react";

import {
  resetAgentChat,
  setAgentChat,
  sentPrompts,
  stopCount,
  textMessage,
  useAgentChatMock,
} from "../../../test/agent-chat-mock";
import { ChatApiProvider, type ChatExtension } from "../chat-api";
import { ChatRuntimeProvider } from "../chat-runtime";
import type { ChatMotion, ChatMotionOverride } from "../chat-motion";
import { ChatPage } from "./chat-page";

// jsdom has no layout engine, so the auto-scroll effect's scrollIntoView is a no-op here.
globalThis.HTMLElement.prototype.scrollIntoView = () => {};

/** A read-aloud extension that synthesizes every answer to the same playable clip. */
const readAloud: ChatExtension = {
  synthesizeSpeech: () => Promise.resolve("data:audio/mpeg;base64,QUJD"),
};

type MotionMockProps = HTMLAttributes<HTMLElement> & {
  initial?: unknown;
  animate?: unknown;
  exit?: unknown;
  transition?: unknown;
  layout?: unknown;
};

// framer-motion does not animate under jsdom: it applies the `initial` style and stops. Both
// signals a test could read are constant. Plain elements make presence mean what it means in a
// browser: the component decided to render it. That is what these tests check.
const AnimatePresenceStub = ({ children }: { children?: ReactNode }) => <>{children}</>;

const motionStub = new Proxy(
  {},
  {
    get: (_target, tag: string) =>
      function Motion(props: MotionMockProps) {
        // Drop the animation-only props; the rest are real DOM attributes.
        const { initial, animate, exit, transition, layout, ...rest } = props;
        void [initial, animate, exit, transition, layout];
        return createElement(tag, rest);
      },
  },
);

const motionOverride: ChatMotionOverride = {
  AnimatePresence: AnimatePresenceStub,
  // SAFETY: framer-motion types `motion` as an exhaustive map of tag-specific components, which a
  // Proxy cannot be written as. The Proxy answers every tag the chat components render, which is
  // the whole surface this suite exercises, and the stand-in is confined to this file.
  motion: motionStub as ChatMotion["motion"],
};

const renderChatPage = (extensions: ChatExtension = readAloud) =>
  render(
    <ChatRuntimeProvider transport={{ useAgentChat: useAgentChatMock }} motion={motionOverride}>
      <ChatApiProvider extensions={extensions}>
        <ChatPage />
      </ChatApiProvider>
    </ChatRuntimeProvider>,
  );

/** Stands in for the `HTMLAudioElement` read-aloud creates; jsdom cannot play media. */
class FakeAudio {
  static instances: FakeAudio[] = [];

  paused = true;
  private readonly listeners: (() => void)[] = [];

  constructor(readonly src: string) {
    FakeAudio.instances.push(this);
  }

  addEventListener(type: string, listener: () => void) {
    if (type === "ended") this.listeners.push(listener);
  }

  play() {
    this.paused = false;
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
  }

  end() {
    for (const listener of this.listeners) listener();
  }
}

type ClipboardState = { written: string[]; fail?: boolean };

/** Records what the clipboard was asked to hold; jsdom ships no `navigator.clipboard`. */
function stubClipboard(): ClipboardState {
  const state: ClipboardState = { written: [] };
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string) => {
        if (state.fail) return Promise.reject(new Error("Denied"));
        state.written.push(text);
        return Promise.resolve();
      },
    },
  });
  return state;
}

function ask(screen: ReturnType<typeof render>, question: string) {
  const textarea = screen.getByLabelText("Chat message");
  fireEvent.change(textarea, { target: { value: question } });
  fireEvent.submit(textarea.closest("form")!);
}

/** Drives one turn to a settled answer through the mocked SDK snapshot. */
function answered(question: string, answer: string) {
  setAgentChat({
    status: "ready",
    messages: [textMessage("u-1", "user", question), textMessage("a-1", "assistant", answer)],
  });
}

const realAudio = globalThis.Audio;
beforeEach(() => resetAgentChat());
afterEach(() => {
  globalThis.Audio = realAudio;
  FakeAudio.instances = [];
  Reflect.deleteProperty(globalThis.navigator, "clipboard");
  cleanup();
});

describe("ChatPage", () => {
  test("sends a prompt and renders the streamed answer", async () => {
    const screen = renderChatPage();

    ask(screen, "How do evals work?");
    expect(sentPrompts()).toEqual(["How do evals work?"]);

    setAgentChat({
      status: "streaming",
      messages: [
        textMessage("u-1", "user", "How do evals work?"),
        textMessage("a-1", "assistant", "Routing to evals.", "streaming"),
      ],
    });
    await waitFor(() => expect(screen.getByText("How do evals work?")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Routing to evals.")).toBeTruthy());

    answered("How do evals work?", "Routing to the evals subagent.");
    await waitFor(() => expect(screen.getByText("Routing to the evals subagent.")).toBeTruthy());
  });

  test("replaces the bubble on each snapshot instead of appending", async () => {
    const screen = renderChatPage();

    ask(screen, "Say hello");
    setAgentChat({
      status: "streaming",
      messages: [
        textMessage("u-1", "user", "Say hello"),
        textMessage("a-1", "assistant", "Hello", "streaming"),
      ],
    });
    await waitFor(() => expect(screen.getByText("Hello")).toBeTruthy());

    setAgentChat({
      status: "streaming",
      messages: [
        textMessage("u-1", "user", "Say hello"),
        textMessage("a-1", "assistant", "Hello there", "streaming"),
      ],
    });
    await waitFor(() => expect(screen.getByText("Hello there")).toBeTruthy());

    setAgentChat({
      status: "ready",
      messages: [
        textMessage("u-1", "user", "Say hello"),
        textMessage("a-1", "assistant", "Hello there"),
      ],
    });

    await waitFor(() => expect(screen.queryByLabelText("Stop generating")).toBeNull());
    expect(screen.queryByText("HelloHello there")).toBeNull();
    expect(screen.getAllByText("Hello there")).toHaveLength(1);
  });

  test("renders a failed turn as an error answer", async () => {
    const screen = renderChatPage();

    ask(screen, "Break something");
    setAgentChat({ status: "error", error: new Error("The agent run failed."), messages: [] });

    await waitFor(() => {
      const failure = screen.getByText("The agent run failed.");
      expect(failure.closest(".text-basic-red-strong")).toBeTruthy();
    });
  });

  test("stop asks the SDK to cancel the running turn", async () => {
    const screen = renderChatPage();

    ask(screen, "Take your time");
    setAgentChat({
      status: "streaming",
      messages: [
        textMessage("u-1", "user", "Take your time"),
        textMessage("a-1", "assistant", "Partial", "streaming"),
      ],
    });

    const stopButton = await waitFor(() => screen.getByLabelText("Stop generating"));
    fireEvent.click(stopButton);

    expect(stopCount()).toBe(1);
  });

  test("offers no assistant actions until the answer has finished streaming", async () => {
    const screen = renderChatPage();

    ask(screen, "Take your time");
    setAgentChat({
      status: "streaming",
      messages: [
        textMessage("u-1", "user", "Take your time"),
        textMessage("a-1", "assistant", "Thinking", "streaming"),
      ],
    });
    await waitFor(() => expect(screen.getByText("Thinking")).toBeTruthy());
    expect(screen.queryByLabelText("Copy")).toBeNull();

    answered("Take your time", "Done.");
    await waitFor(() => expect(screen.getByLabelText("Copy")).toBeTruthy());
  });
});

describe("ChatPage assistant actions", () => {
  test("copy writes the answer to the clipboard", async () => {
    const clipboard = stubClipboard();
    const screen = renderChatPage();

    answered("Say something", "Copy me.");
    await waitFor(() => expect(screen.getByLabelText("Copy")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Copy"));

    await waitFor(() => expect(clipboard.written).toEqual(["Copy me."]));
  });

  test("copy on a question writes the question, not the answer below it", async () => {
    const clipboard = stubClipboard();
    const screen = renderChatPage();

    answered("How do evals work?", "Copy me.");
    await waitFor(() => expect(screen.getByLabelText("Copy message")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Copy message"));

    await waitFor(() => expect(clipboard.written).toEqual(["How do evals work?"]));
  });

  test("read aloud plays the synthesized answer and returns to idle when it ends", async () => {
    // Installed via `Object.assign` rather than a cast: the fake covers only the `<audio>` surface
    // read-aloud drives, not the full `typeof Audio`.
    Object.assign(globalThis, { Audio: FakeAudio });
    const screen = renderChatPage();

    answered("Say something", "Spoken answer.");
    await waitFor(() => expect(screen.getByLabelText("Read aloud")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Read aloud"));

    await waitFor(() => expect(screen.getByLabelText("Stop reading aloud")).toBeTruthy());
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0]?.src).toBe("data:audio/mpeg;base64,QUJD");
    expect(FakeAudio.instances[0]?.paused).toBe(false);

    FakeAudio.instances[0]?.end();

    await waitFor(() => expect(screen.getByLabelText("Read aloud")).toBeTruthy());
  });

  test("offers no read aloud when no chat extension provides it", async () => {
    const screen = renderChatPage({});

    answered("Say something", "Silent answer.");
    await waitFor(() => expect(screen.getByLabelText("Copy")).toBeTruthy());
    expect(screen.queryByLabelText("Read aloud")).toBeNull();
  });

  test("read aloud stops what it was playing when asked again", async () => {
    // Installed via `Object.assign` rather than a cast: the fake covers only the `<audio>` surface
    // read-aloud drives, not the full `typeof Audio`.
    Object.assign(globalThis, { Audio: FakeAudio });
    const screen = renderChatPage();

    answered("Say something", "Spoken answer.");
    await waitFor(() => expect(screen.getByLabelText("Read aloud")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Read aloud"));
    await waitFor(() => expect(screen.getByLabelText("Stop reading aloud")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Stop reading aloud"));

    await waitFor(() => expect(screen.getByLabelText("Read aloud")).toBeTruthy());
    expect(FakeAudio.instances[0]?.paused).toBe(true);
  });
});

/** jsdom reports every box as 0x0, so the scroller's metrics are supplied by hand. */
async function scrolledUp(screen: ReturnType<typeof render>) {
  await waitFor(() =>
    expect(screen.container.querySelector("[class*=overflow-y-auto]")).not.toBeNull(),
  );
  const scroller = screen.container.querySelector("[class*=overflow-y-auto]")!;
  Object.defineProperty(scroller, "scrollHeight", { value: 4000, configurable: true });
  Object.defineProperty(scroller, "clientHeight", { value: 600, configurable: true });
  Object.defineProperty(scroller, "scrollTop", { value: 0, writable: true, configurable: true });
  fireEvent.scroll(scroller);
}

const scrollButtonShown = (screen: ReturnType<typeof render>) =>
  screen.queryByLabelText("Scroll to latest message") !== null;

describe("the scroll-to-latest affordance", () => {
  test("it goes away with the thread it belongs to", async () => {
    const screen = renderChatPage();

    setAgentChat({
      sessionId: "s-1",
      status: "ready",
      messages: [
        textMessage("u-1", "user", "A long thread"),
        textMessage("a-1", "assistant", "Answer."),
      ],
    });
    await scrolledUp(screen);
    await waitFor(() => expect(scrollButtonShown(screen)).toBe(true));

    // "New chat": the thread empties and the scroller unmounts, so no scroll event will ever
    // fire to retract the button.
    setAgentChat({ sessionId: null, status: "ready", messages: [] });

    await waitFor(() => expect(scrollButtonShown(screen)).toBe(false));
  });

  test("opening a different conversation starts at the newest message", async () => {
    const screen = renderChatPage();

    setAgentChat({
      sessionId: "s-1",
      status: "ready",
      messages: [
        textMessage("u-1", "user", "A long thread"),
        textMessage("a-1", "assistant", "Answer."),
      ],
    });
    await scrolledUp(screen);
    await waitFor(() => expect(scrollButtonShown(screen)).toBe(true));

    setAgentChat({
      sessionId: "s-2",
      status: "ready",
      messages: [
        textMessage("u-9", "user", "Another thread"),
        textMessage("a-9", "assistant", "Other."),
      ],
    });

    await waitFor(() => expect(scrollButtonShown(screen)).toBe(false));
  });
});
