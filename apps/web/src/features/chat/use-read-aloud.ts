import {
  useReadAloud as useReadAloudBase,
  type UseReadAloudResult as UseReadAloudBaseResult,
} from "@mistralai-capabilities/feature-chat/web";

import { useChatExtensions } from "./chat-api";

export type { ReadAloudStatus } from "@mistralai-capabilities/feature-chat/web";

/** The read-aloud hook's result, plus whether any capability provides speech synthesis at all. */
export type UseReadAloudResult = UseReadAloudBaseResult & { isAvailable: boolean };

/** Never called: the thread offers no read-aloud action while `isAvailable` is false. */
const noSynthesis = () => Promise.reject(new Error("Read-aloud is not available."));

export function useReadAloud(): UseReadAloudResult {
  const { synthesizeSpeech } = useChatExtensions();
  const readAloud = useReadAloudBase(synthesizeSpeech ?? noSynthesis);
  return { ...readAloud, isAvailable: synthesizeSpeech !== undefined };
}
