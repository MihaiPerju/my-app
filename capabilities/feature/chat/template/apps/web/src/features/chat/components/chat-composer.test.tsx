import "../../../test/setup.js";

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import { ChatApiProvider, type ChatExtension } from "../chat-api";

const { ChatComposer } = await import("./chat-composer");

type RecorderEvent = { data: Blob };
type Listener = (event: RecorderEvent | undefined) => void;

class FakeMediaRecorder {
  static isTypeSupported = () => true;
  static latest: FakeMediaRecorder | null = null;

  state: "inactive" | "recording" = "inactive";
  private readonly listeners = new Map<string, Listener[]>();

  constructor() {
    FakeMediaRecorder.latest = this;
  }

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    for (const listener of this.listeners.get("stop") ?? []) {
      listener(undefined);
    }
  }

  pushChunk() {
    for (const listener of this.listeners.get("dataavailable") ?? []) {
      listener({ data: new Blob(["aaa"], { type: "audio/webm" }) });
    }
  }
}

/**
 * A dictation extension whose transcription never lands, so the composer stays in whichever
 * dictation state the test set up.
 */
const pendingDictation = { transcribeAudio: () => new Promise<string>(() => undefined) };

const realMediaRecorder = globalThis.MediaRecorder;

afterEach(() => {
  globalThis.MediaRecorder = realMediaRecorder;
  FakeMediaRecorder.latest = null;
  cleanup();
});

function mount(
  onSend: (message: string) => void = () => undefined,
  extensions: ChatExtension = pendingDictation,
) {
  // Installed via `Object.assign` rather than a cast: the fake models only the recorder surface
  // the composer drives, not the full `MediaRecorder` type (its typed event overloads, private
  // state), which is neither needed nor faithfully implementable in a test.
  Object.assign(globalThis, { MediaRecorder: FakeMediaRecorder });
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop: () => undefined }] }),
    },
  });
  return render(
    <ChatApiProvider extensions={extensions}>
      <ChatComposer onSend={onSend} />
    </ChatApiProvider>,
  );
}

describe("ChatComposer voice input", () => {
  test("offers no microphone when no chat extension provides dictation", () => {
    const screen = mount(undefined, {});

    expect(screen.queryByLabelText("Start voice input")).toBeNull();

    fireEvent.change(screen.getByLabelText("Chat message"), { target: { value: "hello" } });
    expect(screen.getByLabelText("Send message")).toBeTruthy();
  });

  test("offers the microphone while the composer is empty and swaps to send once typed", () => {
    const screen = mount();

    expect(screen.getByLabelText("Start voice input")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Chat message"), { target: { value: "hello" } });

    expect(screen.queryByLabelText("Start voice input")).toBeNull();
    expect(screen.getByLabelText("Send message")).toBeTruthy();
  });

  // Discard lost its button — Stop, which KEEPS the utterance, is the only one left — so the
  // key is now the whole affordance and the hint beside Stop is the only thing advertising it.
  test("recording offers stop alone, and Escape discards back to the microphone", async () => {
    const screen = mount();

    fireEvent.click(screen.getByLabelText("Start voice input"));

    await waitFor(() => screen.getByLabelText("Stop voice input"));
    expect(screen.queryByLabelText("Discard voice input")).toBeNull();
    expect(screen.getByText("Esc to discard")).toBeTruthy();

    // Fired at the textarea rather than the document: the listener is on `window`, so this
    // also pins that a keystroke from inside the composer still reaches it.
    fireEvent.keyDown(screen.getByLabelText("Chat message"), { key: "Escape" });

    await waitFor(() => expect(screen.getByLabelText("Start voice input")).toBeTruthy());
    expect(screen.queryByLabelText("Stop voice input")).toBeNull();
  });

  // The lockout the cross used to cover: while the final transcription is in flight Stop is
  // disabled and the composer cannot send, so Escape is the ONLY live control on screen.
  test("Escape still discards while the final transcription is in flight", async () => {
    const screen = mount();

    fireEvent.click(screen.getByLabelText("Start voice input"));
    await waitFor(() => screen.getByLabelText("Stop voice input"));

    FakeMediaRecorder.latest?.pushChunk();
    fireEvent.click(screen.getByLabelText("Stop voice input"));

    const transcribing = await waitFor(() => screen.getByLabelText("Transcribing"));
    expect(transcribing.hasAttribute("disabled")).toBe(true);

    fireEvent.keyDown(globalThis.document.body, { key: "Escape" });

    await waitFor(() => expect(screen.getByLabelText("Start voice input")).toBeTruthy());
  });

  // The draft lives here rather than in ChatPage, so sending has to both hand the text up
  // and clear the box. Lifting it back would re-parse every answer's markdown per keystroke.
  test("hands the draft to onSend and empties itself", () => {
    const sent: string[] = [];
    const screen = mount((message) => sent.push(message));

    // SAFETY: `ChatComposer` renders exactly one element labelled "Chat message" and it is the
    // `<textarea>`; the query throws if it is missing. The bound queries `render` returns are not
    // generic, and the bun/jsdom environment defines no `HTMLTextAreaElement` to test against, so
    // the element type cannot be established any other way here.
    const textarea = screen.getByLabelText("Chat message") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "what is a boulder" } });
    fireEvent.submit(textarea.closest("form")!);

    expect(sent).toEqual(["what is a boulder"]);
    expect(textarea.value).toBe("");
    expect(screen.getByLabelText("Start voice input")).toBeTruthy();
  });

  // Dictation writes into the textarea as it goes. If that were allowed to flip the
  // control back to Send, Enter would fire off half of the user's sentence.
  test("does not send while dictation is filling the textarea", async () => {
    let sent = 0;
    const screen = mount(() => {
      sent += 1;
    });

    fireEvent.click(screen.getByLabelText("Start voice input"));
    await waitFor(() => screen.getByLabelText("Stop voice input"));

    const textarea = screen.getByLabelText("Chat message");
    fireEvent.change(textarea, { target: { value: "half a sentence" } });

    expect(screen.queryByLabelText("Send message")).toBeNull();
    expect(screen.getByLabelText("Stop voice input")).toBeTruthy();

    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.submit(textarea.closest("form")!);
    expect(sent).toBe(0);
  });
});
