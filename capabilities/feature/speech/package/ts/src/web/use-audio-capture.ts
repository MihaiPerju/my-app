/**
 * Self-contained microphone capture hook using AudioWorklet.
 *
 * Captures PCM16 audio at the device's native sample rate and calls a callback for each int16 chunk.
 * Chunks are gated: they flow only after {@link openGate} is called. This lets callers send
 * `session.update` with the actual sample rate before any audio reaches the server.
 */
import { useCallback, useEffect, useRef, useState } from "react";

const AUDIO_WORKLET_PROCESSOR_CODE = `
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input.length > 0) {
      const float32Data = input[0];
      const int16Data = new Int16Array(float32Data.length);

      for (let i = 0; i < float32Data.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Data[i]));
        int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }

      this.port.postMessage(int16Data.buffer, [int16Data.buffer]);
    }
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
`;
export interface UseAudioCaptureResult {
  isRecording: boolean;
  isSupported: boolean;
  /** Start mic capture. Returns the device's actual sample rate. Chunks are gated until {@link openGate}. */
  startCapture: () => Promise<number>;
  stopCapture: () => void;
  /** Start forwarding captured audio chunks to the onAudioChunk callback. */
  openGate: () => void;
  /** Stop forwarding chunks without tearing the mic down — used to hold audio during a reconnect
   *  handshake so `session.update` reaches the fresh session before any audio does. */
  closeGate: () => void;
}

export function useAudioCapture(
  onAudioChunk: (chunk: ArrayBuffer) => void,
  onError?: (error: unknown) => void,
): UseAudioCaptureResult {
  const [isRecording, setIsRecording] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const onChunkRef = useRef(onAudioChunk);
  const onErrorRef = useRef(onError);
  const gateOpenRef = useRef(false);

  onChunkRef.current = onAudioChunk;
  onErrorRef.current = onError;

  const isSupported =
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof AudioContext !== "undefined";

  const cleanup = useCallback(() => {
    gateOpenRef.current = false;

    workletNodeRef.current?.disconnect();
    workletNodeRef.current = null;

    sourceRef.current?.disconnect();
    sourceRef.current = null;

    const stream = streamRef.current;
    streamRef.current = null;
    stream?.getTracks().forEach((t) => t.stop());

    const ctx = audioContextRef.current;
    audioContextRef.current = null;
    if (ctx && (ctx.state === "running" || ctx.state === "suspended")) {
      void ctx.close();
    }

    setIsRecording(false);
  }, []);

  const openGate = useCallback(() => {
    gateOpenRef.current = true;
  }, []);

  const closeGate = useCallback(() => {
    gateOpenRef.current = false;
  }, []);

  const startCapture = useCallback(async (): Promise<number> => {
    if (isRecording) {
      return audioContextRef.current?.sampleRate ?? 16000;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: { ideal: 16000 } },
      });
      streamRef.current = stream;

      // Use the device's native sample rate (Firefox will not honour a requested rate).
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      const actualSampleRate = audioContext.sampleRate;

      await audioContext.audioWorklet.addModule(
        URL.createObjectURL(
          new Blob([AUDIO_WORKLET_PROCESSOR_CODE], {
            type: "application/javascript",
          }),
        ),
      );

      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;

      const workletNode = new AudioWorkletNode(audioContext, "pcm-processor");
      workletNodeRef.current = workletNode;

      workletNode.port.addEventListener("message", (event: MessageEvent) => {
        if (gateOpenRef.current && event.data instanceof ArrayBuffer) {
          onChunkRef.current(event.data);
        }
      });
      workletNode.port.start();

      source.connect(workletNode);
      setIsRecording(true);

      return actualSampleRate;
    } catch (error) {
      cleanup();
      onErrorRef.current?.(error);
      throw error;
    }
  }, [isRecording, cleanup]);

  const stopCapture = useCallback(() => {
    cleanup();
  }, [cleanup]);

  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  return { isRecording, isSupported, startCapture, stopCapture, openGate, closeGate };
}
