import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { ChatApi } from "../api";

// Read-aloud for one assistant message at a time: idle -> loading -> playing -> idle.
//
// One at a time is the whole design. Two answers talking over each other is unusable. Starting a
// read stops whatever plays and aborts whatever is still synthesizing. The state is a single slot
// keyed by message id, not a map. A map would let two reads exist with nothing to arbitrate them.

const SYNTHESIS_ERROR = "Could not read this message aloud. Please try again.";

export type ReadAloudStatus = "idle" | "loading" | "playing";

export type UseReadAloudResult = {
  /** `idle` for every message except the one currently loading or playing. */
  statusOf: (messageId: string) => ReadAloudStatus;
  /** Starts reading `text`, or stops it if that message is already the active one. */
  toggle: (messageId: string, text: string) => void;
};

type ActiveRead = { messageId: string; status: Exclude<ReadAloudStatus, "idle"> };

export function useReadAloud(synthesizeSpeech: NonNullable<ChatApi["synthesizeSpeech"]>): UseReadAloudResult {
  const [active, setActive] = useState<ActiveRead | null>(null);
  // `toggle` has to know which message is speaking, but it is handed to every bubble in the
  // thread — deriving it from `active` would rebuild the callback on each play/stop and
  // re-render (and re-parse the markdown of) every answer on screen. The ref is written
  // beside each state write, so the two can never disagree.
  const activeRef = useRef<ActiveRead | null>(null);
  const commitActive = useCallback((next: ActiveRead | null) => {
    activeRef.current = next;
    setActive(next);
  }, []);
  // Same reason: the injected implementation is read through a ref, so passing a fresh
  // function identity cannot rebuild `toggle` and re-render the whole thread.
  const synthesizeRef = useRef(synthesizeSpeech);
  synthesizeRef.current = synthesizeSpeech;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Bumped by every start, stop and unmount. A synthesis that resolves late, or an `ended`
  // event from an element already discarded, compares its captured value and finds itself
  // superseded — the alternative is a stale read resurrecting the button it no longer owns.
  const runRef = useRef(0);

  const discard = useCallback(() => {
    runRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    audioRef.current?.pause();
    audioRef.current = null;
  }, []);

  const start = useCallback(
    (messageId: string, text: string) => {
      discard();
      const run = runRef.current;
      const controller = new AbortController();
      abortRef.current = controller;
      commitActive({ messageId, status: "loading" });

      void (async () => {
        try {
          const source = await synthesizeRef.current(text, { signal: controller.signal });
          if (runRef.current !== run) return;

          const audio = new Audio(source);
          audioRef.current = audio;
          audio.addEventListener("ended", () => {
            if (runRef.current !== run) return;
            audioRef.current = null;
            commitActive(null);
          });

          await audio.play();
          if (runRef.current !== run) return;
          commitActive({ messageId, status: "playing" });
        } catch {
          // A superseded run reaches here too — the abort rejects the fetch — and it must
          // stay silent: the user did not fail at anything, they clicked something else.
          if (runRef.current !== run) return;
          audioRef.current = null;
          commitActive(null);
          toast.error(SYNTHESIS_ERROR);
        } finally {
          if (abortRef.current === controller) {
            abortRef.current = null;
          }
        }
      })();
    },
    [commitActive, discard],
  );

  const toggle = useCallback(
    (messageId: string, text: string) => {
      if (activeRef.current?.messageId === messageId) {
        discard();
        commitActive(null);
        return;
      }
      start(messageId, text);
    },
    [commitActive, discard, start],
  );

  const statusOf = useCallback(
    (messageId: string): ReadAloudStatus =>
      active?.messageId === messageId ? active.status : "idle",
    [active],
  );

  useEffect(() => discard, [discard]);

  return { statusOf, toggle };
}
