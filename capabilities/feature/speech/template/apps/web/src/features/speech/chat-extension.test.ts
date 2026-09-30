import { afterEach, describe, expect, test } from "bun:test";

import { client } from "@/api/generated/client.gen";
import speechChatExtension from "../chat/extensions/speech";

// Destructured so the assertions below read as the two round trips they exercise. Neither
// implementation touches `this`, so detaching them from the object is behaviour-preserving.
const { synthesizeSpeech, transcribeAudio } = speechChatExtension;

// The client resolves its base URL from VITE_API_URL, which is developer-specific.
// Pin it so the assertions below hold regardless of the local .env.
const API_ORIGIN = "http://api.test";
client.setConfig({ baseUrl: API_ORIGIN });

const SYNTHESIZE_URL = `${API_ORIGIN}/api/v1/speech/synthesize/executions`;
const TRANSCRIBE_URL = `${API_ORIGIN}/api/v1/speech/transcribe/executions`;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// The generated SDK calls `fetch(new Request(...))`, so there is no `init` to inspect —
// method and body have to be read back off the Request itself.
type SdkCall = { url: string; method: string; body: Promise<string> };

// The three response bodies these stubs serve: the two success shapes and the error envelope.
type StubbedResponse =
  | { audio_base64: string; model: string; response_format: string }
  | { model: string; text: string; segments: unknown[] }
  | { detail: string };

// The request bodies the two round trips build, read back off the captured Request. Every field
// is optional because a given call sets only its own subset.
type RequestBody = {
  input?: string;
  voice_id?: string;
  response_format?: string;
  file_content?: string;
  file_name?: string;
  language?: string;
};

/** Serves one JSON response, capturing the Request the generated SDK built. */
function stubJson(payload: StubbedResponse, status: number): SdkCall[] {
  const calls: SdkCall[] = [];
  // SAFETY: the generated SDK issues exactly one `fetch(new Request(...))`; this stub answers it
  // and captures the Request. The cast supplies the rest of `typeof fetch`, none of it exercised.
  globalThis.fetch = ((input: string | URL | Request) => {
    const request = input instanceof Request ? input : new Request(String(input));
    calls.push({ url: request.url, method: request.method, body: request.clone().text() });
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return calls;
}

async function bodyOf(calls: SdkCall[]): Promise<RequestBody> {
  return JSON.parse((await calls[0]?.body) ?? "{}");
}

describe("synthesizeSpeech", () => {
  const spoken = { audio_base64: "QUJD", model: "voxtral-mini-tts-2603", response_format: "mp3" };

  test("POSTs to the speech synthesize mount and returns a playable mp3 data URL", async () => {
    const calls = stubJson(spoken, 200);

    expect(await synthesizeSpeech("Read this out.")).toBe("data:audio/mpeg;base64,QUJD");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(SYNTHESIZE_URL);
    expect(calls[0]?.method).toBe("POST");
    expect(await bodyOf(calls)).toEqual({
      input: "Read this out.",
      voice_id: "en_paul_neutral",
      response_format: "mp3",
    });
  });

  // `SynthesizeRequest._exactly_one_voice` 422s a request carrying both `voice_id` and
  // `ref_audio`, and one carrying neither. Adding either half here breaks every read-aloud.
  test("names exactly one voice source", async () => {
    const calls = stubJson(spoken, 200);

    await synthesizeSpeech("hi");

    const body = await bodyOf(calls);
    expect(body.voice_id).toBe("en_paul_neutral");
    expect(body).not.toHaveProperty("ref_audio");
  });

  // Pinning the model client-side would outlive the server's default the day it moves.
  test("leaves the model to the server default", async () => {
    const calls = stubJson(spoken, 200);

    await synthesizeSpeech("hi");

    expect(await bodyOf(calls)).not.toHaveProperty("model");
  });

  test("rejects with the API detail on a non-2xx response", async () => {
    stubJson({ detail: "Unknown voice" }, 422);

    await expect(synthesizeSpeech("hi")).rejects.toThrow("Unknown voice");
  });
});

describe("transcribeAudio", () => {
  const spoken = { model: "voxtral-mini-latest", text: "Hello there", segments: [] };

  test("POSTs the recording to the transcribe mount and returns its text", async () => {
    const calls = stubJson(spoken, 200);

    expect(await transcribeAudio(new Blob(["aaa"], { type: "audio/webm" }))).toBe("Hello there");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(TRANSCRIBE_URL);
    expect(calls[0]?.method).toBe("POST");
    // `file_content` is the only source set; sending `file_url`/`file_id` too would be a 422.
    const body = await bodyOf(calls);
    expect(body).toHaveProperty("file_content");
    expect(body).not.toHaveProperty("file_url");
    expect(body).not.toHaveProperty("file_id");
  });

  test("rejects with the API detail on a non-2xx response", async () => {
    stubJson({ detail: "Transcription failed." }, 500);

    await expect(transcribeAudio(new Blob(["aaa"], { type: "audio/webm" }))).rejects.toThrow(
      "Transcription failed.",
    );
  });
});
