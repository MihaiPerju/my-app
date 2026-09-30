import { useCallback, useRef, useState } from "react";

import type { ChatApi } from "../api";
import type { MessageRating } from "../types";

export type UseFeedbackResult = {
  ratingOf: (messageId: string) => MessageRating | null;
  rate: (messageId: string, direction: MessageRating) => void;
};

/**
 * Owns which answers this session has rated.
 *
 * Votes live in a Map keyed by the SDK message id and are lost on reload. Rating replaces a vote;
 * rating the lit direction withdraws it, so one thumb is lit at most. The write is fire-and-forget
 * telemetry, never awaited, and a rate before the SDK mints `sessionId` is a no-op.
 */
export function useFeedback(
  submitFeedback: ChatApi["submitFeedback"],
  sessionId: string | null,
): UseFeedbackResult {
  const [votes, setVotes] = useState<Map<string, MessageRating>>(() => new Map());

  // `rate` must keep one identity for the life of the thread, or every settled bubble re-renders
  // on each vote and `chat-thread-memo.test.tsx` fails. So the current votes are read here rather
  // than from the state closure, which would put `votes` in its dependencies.
  const votesRef = useRef(votes);
  votesRef.current = votes;

  // Same reason: the injected implementation is read through a ref so that an inline object
  // literal at the call site cannot rebuild `rate` on every render.
  const submitRef = useRef(submitFeedback);
  submitRef.current = submitFeedback;

  const ratingOf = useCallback(
    (messageId: string): MessageRating | null => votes.get(messageId) ?? null,
    [votes],
  );

  const rate = useCallback(
    (messageId: string, direction: MessageRating) => {
      if (sessionId === null) return;

      const withdrawing = votesRef.current.get(messageId) === direction;

      setVotes((previous) => {
        const next = new Map(previous);
        if (previous.get(messageId) === direction) next.delete(messageId);
        else next.set(messageId, direction);
        return next;
      });

      // A withdrawal sends nothing. The signal is an append-only stream of evaluation events with
      // no retraction, so re-posting the rating being taken back would land a second identical
      // event and count the vote twice.
      if (withdrawing) return;
      void submitRef
        .current({
          session_id: sessionId,
          message_id: messageId,
          rating: direction,
        })
        .catch(() => undefined);
    },
    [sessionId],
  );

  return { ratingOf, rate };
}
