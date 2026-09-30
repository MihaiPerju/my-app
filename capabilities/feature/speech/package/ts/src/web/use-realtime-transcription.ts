/**
 * Main orchestration hook for realtime transcription.
 *
 * The transcript uses two slices so reconnect cannot duplicate or lose text: `committed` holds
 * earlier sessions, `current` holds the live session. On a drop the hook folds `current` into
 * `committed`, so the fresh session appends without overwriting committed text.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { SpeechApi } from "../api";
import type { RealtimeClientMessage, RealtimeServerMessage } from "../types";

import { useAudioCapture } from "./use-audio-capture";
import { useWebSocketSession, type WebSocketReducerResult } from "./use-websocket-session";

interface RealtimeSessionData {
  committed: string;
  current: string;
  isReady: boolean;
}

const INITIAL_DATA: RealtimeSessionData = { committed: "", current: "", isReady: false };

const MAX_RECONNECT_ATTEMPTS = 5;

function realtimeReducer(
  data: RealtimeSessionData,
  msg: RealtimeServerMessage,
): WebSocketReducerResult<RealtimeSessionData> {
  switch (msg.type) {
    case "error":
      throw new Error(msg.error.message);
    case "session.created":
    case "session.updated":
      return { data: { ...data, isReady: true }, done: false };
    case "transcription.text.delta":
      return {
        data: { ...data, current: data.current + msg.text, isReady: true },
        done: false,
      };
    case "transcription.done":
      // Atomically replace this session's slice with its authoritative final text.
      return {
        data: { ...data, current: msg.text, isReady: true },
        done: true,
      };
    default:
      return { data, done: false };
  }
}

export interface UseRealtimeTranscriptionResult {
  transcript: string;
  isRecording: boolean;
  isReconnecting: boolean;
  isLoading: boolean;
  isAudioSupported: boolean;
  error: Error | null;
  startTranscription: () => Promise<void>;
  stopTranscription: () => Promise<string>;
  resetTranscription: () => void;
}

export function useRealtimeTranscription(api: SpeechApi): UseRealtimeTranscriptionResult {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const readyResolversRef = useRef<{
    resolve: () => void;
    reject: (err: Error) => void;
    promise: Promise<void>;
  } | null>(null);
  // The device's actual capture rate, captured once at start so a reconnect's `session.update`
  // re-announces the same format the still-running mic is producing.
  const sampleRateRef = useRef(16000);
  const openGateRef = useRef<(() => void) | null>(null);
  const closeGateRef = useRef<(() => void) | null>(null);

  const { state, open, send, cancel, reset, waitForOpen, waitForClose } = useWebSocketSession<
    RealtimeClientMessage,
    RealtimeServerMessage,
    RealtimeSessionData
  >({
    initialData: INITIAL_DATA,
    reducer: realtimeReducer,
    reconnect: {
      maxAttempts: MAX_RECONNECT_ATTEMPTS,
      baseMs: 500,
      capMs: 8000,
      factor: 2,
      isReady: (data) => data.isReady,
      onReconnecting: () => closeGateRef.current?.(),
      commit: (data) => ({ committed: data.committed + data.current, current: "", isReady: false }),
      rehandshake: (sendFn) => {
        sendFn({
          type: "session.update",
          session: {
            audio_format: { encoding: "pcm_s16le", sample_rate: sampleRateRef.current },
            target_streaming_delay_ms: 1000,
          },
        });
        openGateRef.current?.();
      },
    },
  });

  const hasData =
    state.status === "open" ||
    state.status === "closed" ||
    state.status === "error" ||
    state.status === "reconnecting";

  const transcript = hasData ? state.data.committed + state.data.current : "";
  const isReconnecting = state.status === "reconnecting";
  const isReady = hasData && state.data.isReady;

  // Resolve the ready promise once the initial session reports itself ready.
  useEffect(() => {
    if (isReady && readyResolversRef.current) {
      readyResolversRef.current.resolve();
      readyResolversRef.current = null;
    }
  }, [isReady]);

  const onAudioChunk = useCallback(
    (chunk: ArrayBuffer) => {
      const base64 = btoa(String.fromCharCode(...new Uint8Array(chunk)));
      send({ type: "input_audio.append", audio: base64 });
    },
    [send],
  );

  const handleError = useCallback((err: unknown) => {
    const e = err instanceof Error ? err : new Error(String(err));
    setError(e);
    setIsLoading(false);
  }, []);

  const { isRecording, isSupported, startCapture, stopCapture, openGate, closeGate } = useAudioCapture(
    onAudioChunk,
    handleError,
  );
  openGateRef.current = openGate;
  closeGateRef.current = closeGate;

  // A terminal error (reconnect budget spent, malformed/protocol frame, cancellation) tears the mic
  // down and surfaces the reason — including the reconnect-exhausted state — to the UI.
  useEffect(() => {
    if (state.status === "error") {
      if (readyResolversRef.current) {
        readyResolversRef.current.reject(state.error);
        readyResolversRef.current = null;
      }
      setError(state.error);
      stopCapture();
    }
  }, [state, stopCapture]);

  const startTranscription = useCallback(async () => {
    setError(null);
    setIsLoading(true);

    try {
      // Mint a fresh token per (re)connect. This same factory is what the session hook calls again
      // on reconnect, so a short-lived token is never reused past its life.
      open(async () => {
        const { token, ws_url } = await api.realtimeSession({});
        return new WebSocket(new URL(ws_url), ["realtime", token]);
      });
      await waitForOpen();

      let resolve!: () => void;
      let reject!: (err: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      readyResolversRef.current = { resolve, reject, promise };
      await promise;

      // Start the mic gated (chunks buffered, not sent) and record the device's real sample rate.
      const actualSampleRate = await startCapture();
      sampleRateRef.current = actualSampleRate;

      // Announce the audio format BEFORE any chunk flows.
      send({
        type: "session.update",
        session: {
          audio_format: { encoding: "pcm_s16le", sample_rate: actualSampleRate },
          target_streaming_delay_ms: 1000,
        },
      });

      openGate();
    } catch (err) {
      handleError(err);
      cancel();
      stopCapture();
    } finally {
      setIsLoading(false);
    }
  }, [api, open, send, cancel, waitForOpen, startCapture, stopCapture, openGate, handleError]);

  const stopTranscription = useCallback(async (): Promise<string> => {
    setIsLoading(true);
    try {
      stopCapture();
      send({ type: "input_audio.end" });
      const result = await waitForClose();
      return result.committed + result.current;
    } catch (err) {
      handleError(err);
      return transcript;
    } finally {
      setIsLoading(false);
    }
  }, [send, waitForClose, stopCapture, transcript, handleError]);

  const resetTranscription = useCallback(() => {
    stopCapture();
    reset();
    setError(null);
    setIsLoading(false);
  }, [stopCapture, reset]);

  return {
    transcript,
    isRecording,
    isReconnecting,
    isLoading,
    isAudioSupported: isSupported,
    error,
    startTranscription,
    stopTranscription,
    resetTranscription,
  };
}
