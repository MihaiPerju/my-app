import { blobToBase64 } from "@mistralai-capabilities/feature-chat";

import {
  speechSynthesizeCreateExecution,
  speechTranscribeCreateExecution,
} from "@/api/generated/sdk.gen";
import { unwrap } from "@/api/unwrap";

import type { ChatExtension } from "../chat-api";

// Speech's chat extension: dictation in the composer and read-aloud on answers. Chat merges every
// module under this directory into its API, so installing speech is what turns both on. Both are
// round trips to the speech feature's workflow mounts (`transcribe` and `synthesize`), each mounted
// with `wait_for_result=True`, so the response carries the result directly.

/** The preset read-aloud speaks with. One of the ten the TTS model ships with. */
const READ_ALOUD_VOICE_ID = "en_paul_neutral";

/**
 * The transcription request body. `language` is optional on the contract because the key must be
 * absent — not `undefined` — when the caller names no language; an explicit `undefined` would still
 * be serialised.
 */
type TranscribeBody = { file_content: string; file_name: string; language?: string };

const speechChatExtension = {
  /**
   * Transcribes one recording and resolves with its text.
   *
   * `file_content` is the only source set; also sending `file_url` or `file_id` is a 422.
   */
  transcribeAudio: async (audio, options = {}) => {
    const body: TranscribeBody = {
      file_content: await blobToBase64(audio),
      file_name: options.fileName ?? "recording.webm",
    };
    if (options.language !== undefined) body.language = options.language;
    const result = await unwrap(
      speechTranscribeCreateExecution({
        body,
        signal: options.signal,
        throwOnError: true,
      }),
    );
    return result.text;
  },

  /**
   * Synthesizes `text` and resolves with a `src` an `<audio>` element can play.
   *
   * `voice_id` is the only voice source and is mandatory; sending neither it nor `ref_audio`, or
   * both, is a 422. `model` is left off so the server default applies.
   */
  synthesizeSpeech: async (text, options = {}) => {
    const result = await unwrap(
      speechSynthesizeCreateExecution({
        body: { input: text, voice_id: READ_ALOUD_VOICE_ID, response_format: "mp3" },
        signal: options.signal,
        throwOnError: true,
      }),
    );
    // A data URL rather than a blob URL: nothing here owns a lifetime long enough to call
    // `URL.revokeObjectURL`, and an unrevoked blob URL leaks for the life of the document.
    return `data:audio/mpeg;base64,${result.audio_base64}`;
  },
} satisfies ChatExtension;

export default speechChatExtension;
