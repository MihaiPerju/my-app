import { useCallback, useEffect, useRef, useState } from "react";

import type { ChatApi } from "../api";
import { fileNameFor } from "../lib";

// Dictation for the composer: idle -> recording -> transcribing -> idle.
//
// The speech mount is synchronous with no partial-transcript stream, so this hook re-transcribes
// the audio so far on a slow cadence for the live preview. Every result is a snapshot of the whole
// utterance and replaces the previous one. Each pass starts from the beginning, because
// MediaRecorder puts the container header in the first chunk only.

/** Cadence of the live preview. Each tick costs one transcription of the audio so far. */
const PARTIAL_INTERVAL_MS = 3000;
/** How often MediaRecorder hands over a chunk, so a preview has whole blobs to assemble. */
const CHUNK_INTERVAL_MS = 1000;

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

const PERMISSION_ERROR = "Microphone access was denied.";
const TRANSCRIBE_ERROR = "Could not transcribe the recording. Please try again.";

export type VoiceInputStatus = "idle" | "recording" | "transcribing";

export type UseVoiceInputOptions = {
  /** The composer's current value; snapshotted when recording starts so typing survives. */
  text: string;
  onTextChange: (value: string) => void;
  /** Preview cadence. Raise it to trade preview latency for fewer transcriptions. */
  previewIntervalMs?: number;
};

export type UseVoiceInputResult = {
  status: VoiceInputStatus;
  error: string | null;
  isSupported: boolean;
  start: () => void;
  /** Finishes the recording and runs the authoritative transcription over all of it. */
  stop: () => void;
  /** Throws the recording away. Emits nothing and leaves the composer as it was. */
  cancel: () => void;
};

export function useVoiceInput(
  transcribeAudio: NonNullable<ChatApi["transcribeAudio"]>,
  { text, onTextChange, previewIntervalMs = PARTIAL_INTERVAL_MS }: UseVoiceInputOptions,
): UseVoiceInputResult {
  const [status, setStatus] = useState<VoiceInputStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  // Resolved in an effect, never during render: this hook runs under SSR, where
  // MediaRecorder does not exist, and a render-time probe would mismatch on hydration.
  const [isSupported, setIsSupported] = useState(false);

  const statusRef = useRef<VoiceInputStatus>("idle");
  const textRef = useRef(text);
  const onTextChangeRef = useRef(onTextChange);
  // Read through a ref for the same reason as `onTextChange`: `transcribeSoFar` holds an
  // empty dependency list, so the injected implementation must not be captured in its closure.
  const transcribeAudioRef = useRef(transcribeAudio);
  transcribeAudioRef.current = transcribeAudio;

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const baseTextRef = useRef("");
  const fileNameRef = useRef("recording.webm");

  const abortRef = useRef<AbortController | null>(null);
  const previewTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previewBusyRef = useRef(false);
  const previewedChunkCountRef = useRef(0);
  // Set the moment a run stops being previewable: `cancel` discards, `stop` finalises.
  // Either way a preview that is still in flight must no longer touch the composer.
  const discardedRef = useRef(false);
  const finalisingRef = useRef(false);

  useEffect(() => {
    textRef.current = text;
  }, [text]);

  useEffect(() => {
    onTextChangeRef.current = onTextChange;
  }, [onTextChange]);

  useEffect(() => {
    setIsSupported(
      typeof MediaRecorder !== "undefined" &&
        typeof navigator !== "undefined" &&
        typeof navigator.mediaDevices?.getUserMedia === "function",
    );
  }, []);

  const applyStatus = useCallback((next: VoiceInputStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const clearPreviewTimer = useCallback(() => {
    if (previewTimerRef.current !== null) {
      clearInterval(previewTimerRef.current);
      previewTimerRef.current = null;
    }
  }, []);

  const releaseStream = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) {
      track.stop();
    }
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  const emit = useCallback((transcript: string) => {
    const spoken = transcript.trim();
    if (!spoken) return;
    const base = baseTextRef.current.trimEnd();
    onTextChangeRef.current(base ? `${base} ${spoken}` : spoken);
  }, []);

  const transcribeSoFar = useCallback(async (signal: AbortSignal): Promise<string> => {
    const chunks = chunksRef.current;
    const recording = new Blob(chunks, { type: chunks[0]?.type || "audio/webm" });
    return transcribeAudioRef.current(recording, { fileName: fileNameRef.current, signal });
  }, []);

  const runPreview = useCallback(async () => {
    if (previewBusyRef.current || discardedRef.current || finalisingRef.current) return;
    const chunkCount = chunksRef.current.length;
    if (chunkCount === 0 || chunkCount === previewedChunkCountRef.current) return;

    previewedChunkCountRef.current = chunkCount;
    previewBusyRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const transcript = await transcribeSoFar(controller.signal);
      if (!discardedRef.current && !finalisingRef.current) {
        emit(transcript);
      }
    } catch {
      // A preview is disposable. Surfacing its failure would put an error under the
      // composer mid-sentence for something the final transcription may well recover
      // from — and that final one does report its errors.
    } finally {
      previewBusyRef.current = false;
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }, [emit, transcribeSoFar]);

  const finish = useCallback(async () => {
    clearPreviewTimer();
    // Whatever preview is open is now stale: the final pass covers the same audio.
    abortRef.current?.abort();
    abortRef.current = null;

    if (discardedRef.current || chunksRef.current.length === 0) {
      releaseStream();
      chunksRef.current = [];
      applyStatus("idle");
      return;
    }

    applyStatus("transcribing");
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const transcript = await transcribeSoFar(controller.signal);
      if (!discardedRef.current) {
        emit(transcript);
      }
    } catch (err: unknown) {
      if (!discardedRef.current) {
        setError(err instanceof Error && err.message ? err.message : TRANSCRIBE_ERROR);
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      releaseStream();
      chunksRef.current = [];
      applyStatus("idle");
    }
  }, [applyStatus, clearPreviewTimer, emit, releaseStream, transcribeSoFar]);

  const start = useCallback(() => {
    if (statusRef.current !== "idle") return;

    setError(null);
    discardedRef.current = false;
    finalisingRef.current = false;
    chunksRef.current = [];
    previewedChunkCountRef.current = 0;
    previewBusyRef.current = false;
    baseTextRef.current = textRef.current;

    void (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        setError(PERMISSION_ERROR);
        return;
      }

      // `cancel` can land while the permission prompt is open; honour it rather than
      // opening a recorder nobody asked for and leaving the mic indicator lit.
      if (discardedRef.current) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        return;
      }

      const mimeType = MIME_CANDIDATES.find((candidate) =>
        MediaRecorder.isTypeSupported(candidate),
      );
      fileNameRef.current = fileNameFor(mimeType);
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

      streamRef.current = stream;
      recorderRef.current = recorder;

      recorder.addEventListener("dataavailable", (event: BlobEvent) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      });
      recorder.addEventListener("stop", () => {
        void finish();
      });

      recorder.start(CHUNK_INTERVAL_MS);
      applyStatus("recording");
      previewTimerRef.current = setInterval(() => {
        void runPreview();
      }, previewIntervalMs);
    })();
  }, [applyStatus, finish, previewIntervalMs, runPreview]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    finalisingRef.current = true;
    clearPreviewTimer();
    recorder.stop();
  }, [clearPreviewTimer]);

  const cancel = useCallback(() => {
    discardedRef.current = true;
    clearPreviewTimer();
    abortRef.current?.abort();
    abortRef.current = null;

    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      // The `stop` listener runs `finish`, which sees `discardedRef` and only cleans up.
      recorder.stop();
      return;
    }
    releaseStream();
    chunksRef.current = [];
    applyStatus("idle");
  }, [applyStatus, clearPreviewTimer, releaseStream]);

  useEffect(
    () => () => {
      discardedRef.current = true;
      if (previewTimerRef.current !== null) {
        clearInterval(previewTimerRef.current);
      }
      abortRef.current?.abort();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }
      for (const track of streamRef.current?.getTracks() ?? []) {
        track.stop();
      }
    },
    [],
  );

  return { status, error, isSupported, start, stop, cancel };
}
