import "../../test/setup.js";

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { useState } from "react";

import { ChatApiProvider, type ChatExtension } from "./chat-api";

/** Long enough that no preview fires; for tests that only exercise the final pass. */
const NO_PREVIEW = 60_000;

const { useVoiceInput } = await import("./use-voice-input");

type Transcribe = NonNullable<ChatExtension["transcribeAudio"]>;

/** What the dictation extension below does; each test installs its own. */
let transcribe: Transcribe = () => Promise.reject(new Error("no transcription stubbed"));

/** A dictation extension standing in for whichever capability provides one (speech, in an app). */
const dictation: ChatExtension = {
  transcribeAudio: (audio, options) => transcribe(audio, options),
};

type RecorderEvent = { data: Blob };
type Listener = (event: RecorderEvent | undefined) => void;

/** Stands in for the browser recorder; the test decides when chunks and `stop` happen. */
class FakeMediaRecorder {
  static isTypeSupported = (type: string) => type === "audio/webm;codecs=opus";
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
    this.dispatch("stop", undefined);
  }

  /** One `dataavailable`, as MediaRecorder emits per timeslice. */
  pushChunk(payload: string) {
    this.dispatch("dataavailable", { data: new Blob([payload], { type: "audio/webm" }) });
  }

  private dispatch(type: string, event: RecorderEvent | undefined) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

type PendingCall = { signal: AbortSignal | null; resolve: (text: string) => void };

/** Holds every transcription open so the test controls exactly when each one lands. */
function stubTranscribe() {
  const pending: PendingCall[] = [];

  transcribe = (_audio, options = {}) => {
    const signal = options.signal ?? null;
    return new Promise<string>((resolve, reject) => {
      pending.push({ signal, resolve });
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  };

  return {
    calls: () => pending.length,
    /** Lands the most recent transcription. */
    settle: (text: string) => pending.at(-1)?.resolve(text),
    aborted: (index = 0) => pending[index]?.signal?.aborted ?? false,
  };
}

function grantMicrophone(denied: boolean) {
  const track = { stop: () => undefined };
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: () =>
        denied
          ? Promise.reject(new Error("NotAllowedError"))
          : Promise.resolve({ getTracks: () => [track] }),
    },
  });
}

function Harness({
  initialText,
  previewIntervalMs,
}: {
  initialText: string;
  previewIntervalMs: number;
}) {
  const [text, setText] = useState(initialText);
  const voice = useVoiceInput({ text, onTextChange: setText, previewIntervalMs });

  return (
    <div>
      <span data-testid="text">{text}</span>
      <span data-testid="status">{voice.status}</span>
      <span data-testid="error">{voice.error ?? ""}</span>
      <button type="button" onClick={voice.start}>
        start
      </button>
      <button type="button" onClick={voice.stop}>
        stop
      </button>
      <button type="button" onClick={voice.cancel}>
        cancel
      </button>
    </div>
  );
}

const realMediaRecorder = globalThis.MediaRecorder;

afterEach(() => {
  globalThis.MediaRecorder = realMediaRecorder;
  FakeMediaRecorder.latest = null;
  cleanup();
});

function mount(
  options: { denied?: boolean; initialText?: string; previewIntervalMs?: number } = {},
) {
  // Installed via `Object.assign` rather than a cast: the fake models only the recorder surface the
  // hook drives, not the full `MediaRecorder` type (its typed event overloads, private state).
  Object.assign(globalThis, { MediaRecorder: FakeMediaRecorder });
  grantMicrophone(options.denied ?? false);

  const screen = render(
    <ChatApiProvider extensions={dictation}>
      <Harness
        initialText={options.initialText ?? ""}
        previewIntervalMs={options.previewIntervalMs ?? NO_PREVIEW}
      />
    </ChatApiProvider>,
  );

  return {
    text: () => screen.getByTestId("text").textContent,
    status: () => screen.getByTestId("status").textContent,
    error: () => screen.getByTestId("error").textContent,
    press: (label: string) => fireEvent.click(screen.getByText(label)),
  };
}

/** Waits for the getUserMedia promise to have settled and the recorder to be live. */
async function startRecording(ui: ReturnType<typeof mount>) {
  ui.press("start");
  await waitFor(() => expect(ui.status()).toBe("recording"));
  return FakeMediaRecorder.latest!;
}

describe("useVoiceInput", () => {
  test("replaces the composer text on each preview snapshot instead of appending", async () => {
    const stub = stubTranscribe();
    const ui = mount({ previewIntervalMs: 10 });
    const recorder = await startRecording(ui);

    recorder.pushChunk("aaa");
    await waitFor(() => expect(stub.calls()).toBe(1));
    stub.settle("Hello");
    await waitFor(() => expect(ui.text()).toBe("Hello"));

    recorder.pushChunk("bbb");
    await waitFor(() => expect(stub.calls()).toBe(2));
    stub.settle("Hello there");
    await waitFor(() => expect(ui.text()).toBe("Hello there"));

    // The snapshot rule: the second preview re-transcribes the same utterance, so it
    // must overwrite the first. Appending would read "HelloHello there".
    expect(ui.text()).toBe("Hello there");
  });

  test("stop runs a final transcription and settles back to idle", async () => {
    const stub = stubTranscribe();
    const ui = mount();
    const recorder = await startRecording(ui);

    recorder.pushChunk("aaa");
    ui.press("stop");

    await waitFor(() => expect(ui.status()).toBe("transcribing"));
    await waitFor(() => expect(stub.calls()).toBe(1));

    stub.settle("The final answer.");
    await waitFor(() => expect(ui.text()).toBe("The final answer."));
    await waitFor(() => expect(ui.status()).toBe("idle"));
  });

  test("keeps text typed before recording and appends the transcript to it", async () => {
    const stub = stubTranscribe();
    const ui = mount({ initialText: "Draft note:" });
    const recorder = await startRecording(ui);

    recorder.pushChunk("aaa");
    ui.press("stop");
    await waitFor(() => expect(stub.calls()).toBe(1));

    stub.settle("read this back");
    await waitFor(() => expect(ui.text()).toBe("Draft note: read this back"));
  });

  test("the final transcription supersedes a preview still in flight", async () => {
    const stub = stubTranscribe();
    const ui = mount({ previewIntervalMs: 10 });
    const recorder = await startRecording(ui);

    recorder.pushChunk("aaa");
    await waitFor(() => expect(stub.calls()).toBe(1));

    ui.press("stop");
    await waitFor(() => expect(stub.calls()).toBe(2));
    expect(stub.aborted(0)).toBe(true);

    stub.settle("The whole sentence.");
    await waitFor(() => expect(ui.text()).toBe("The whole sentence."));
    await waitFor(() => expect(ui.status()).toBe("idle"));
  });

  test("cancel aborts the in-flight transcription and emits nothing", async () => {
    const stub = stubTranscribe();
    const ui = mount({ previewIntervalMs: 10 });
    const recorder = await startRecording(ui);

    recorder.pushChunk("aaa");
    await waitFor(() => expect(stub.calls()).toBe(1));

    ui.press("cancel");

    await waitFor(() => expect(stub.aborted(0)).toBe(true));
    await waitFor(() => expect(ui.status()).toBe("idle"));
    expect(ui.text()).toBe("");
    expect(ui.error()).toBe("");
    // Cancel must not have started a final pass over the discarded audio.
    expect(stub.calls()).toBe(1);
  });

  test("surfaces a denied microphone instead of pretending to record", async () => {
    stubTranscribe();
    const ui = mount({ denied: true });

    ui.press("start");

    await waitFor(() => expect(ui.error()).toBe("Microphone access was denied."));
    expect(ui.status()).toBe("idle");
  });

  test("reports a failed final transcription and still returns to idle", async () => {
    stubTranscribe();
    const ui = mount();
    const recorder = await startRecording(ui);

    recorder.pushChunk("aaa");
    transcribe = () => Promise.reject(new Error("Transcription failed."));

    ui.press("stop");

    await waitFor(() => expect(ui.error()).toBe("Transcription failed."));
    await waitFor(() => expect(ui.status()).toBe("idle"));
  });
});
