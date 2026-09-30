import {
  useVoiceInput as useVoiceInputBase,
  type UseVoiceInputOptions,
  type UseVoiceInputResult as UseVoiceInputBaseResult,
} from "@mistralai-capabilities/feature-chat/web";

import { useChatExtensions } from "./chat-api";

export type {
  UseVoiceInputOptions,
  VoiceInputStatus,
} from "@mistralai-capabilities/feature-chat/web";

/** The dictation hook's result, plus whether any capability provides transcription at all. */
export type UseVoiceInputResult = UseVoiceInputBaseResult & { isAvailable: boolean };

/** Never called: the composer offers no mic while `isAvailable` is false. */
const noTranscription = () => Promise.reject(new Error("Dictation is not available."));

export function useVoiceInput(options: UseVoiceInputOptions): UseVoiceInputResult {
  const { transcribeAudio } = useChatExtensions();
  const voice = useVoiceInputBase(transcribeAudio ?? noTranscription, options);
  return { ...voice, isAvailable: transcribeAudio !== undefined };
}
