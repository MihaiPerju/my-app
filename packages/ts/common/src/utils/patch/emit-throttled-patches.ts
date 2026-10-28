import { funnel } from "remeda";

import { diff, type Patch } from "./patch";

export type EmitThrottledPatches<T> = {
  (state: T): void;
  flush: () => void;
};

export const emitThrottledPatches = <T>(
  throttleMs: number,
  onTrigger: (patches: Patch<T>[]) => void,
): EmitThrottledPatches<T> => {
  const intervalMs = Math.max(0, throttleMs);

  let lastEmittedState: T | undefined;

  const emitPatches = (state: T) => {
    const patches = diff(lastEmittedState, state);

    if (patches.length === 0) {
      lastEmittedState = state;
      return;
    }

    onTrigger(patches);
    lastEmittedState = state;
  };

  if (intervalMs === 0) {
    const emit = ((state: T) => {
      emitPatches(state);
    }) as EmitThrottledPatches<T>;

    emit.flush = () => {};

    return emit;
  }

  const throttled = funnel(
    (state: T) => {
      emitPatches(state);
    },
    {
      triggerAt: "both",
      minGapMs: intervalMs,
      reducer: (_latestState: T | undefined, state: T) => state,
    },
  );

  const emit = ((state: T) => {
    throttled.call(state);
  }) as EmitThrottledPatches<T>;

  emit.flush = throttled.flush;

  return emit;
};
