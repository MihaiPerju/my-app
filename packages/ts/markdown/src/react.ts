import "./mdast-math";

import {
  useDeferredValue,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";

import {
  createMistralMarkdownReactStore,
  type MistralMarkdownReactOptions,
} from "./react-store";
import type { MarkdownSnapshot } from "./types";

export type UseMistralMarkdownOptions = MistralMarkdownReactOptions;

/**
 * Parses markdown from React without exposing parser sessions to components.
 *
 * `smooth` may change over time:
 * - initial snapshots publish the current source immediately.
 * - `false -> true` starts revealing from the current rendered source.
 * - `true -> false` immediately publishes the latest full source.
 * - `isDone: true` bypasses smoothing and publishes the latest full source.
 * - disconnected trees catch up to the latest source on reconnect, then smooth
 *   later connected updates.
 * - smoothed streaming snapshots are deferred so React can keep rendering the
 *   previous snapshot while preparing the next one.
 *
 */
export function useMistralMarkdown(
  source: string,
  options?: UseMistralMarkdownOptions,
): MarkdownSnapshot {
  const isDone = options?.isDone ?? true;
  const smooth = options?.smooth ?? false;
  const [transforms] = useState(() => options?.unstable_transforms);
  const [store] = useState(() =>
    createMistralMarkdownReactStore(source, {
      isDone,
      smooth,
      unstable_transforms: transforms,
    }),
  );
  store.render(source, {
    isDone,
    smooth,
    unstable_transforms: transforms,
  });
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const deferredSnapshot = useDeferredValue(snapshot);

  useLayoutEffect(() => {
    store.connect();

    return () => store.disconnect();
  }, [store]);

  useLayoutEffect(() => {
    store.update(source, {
      isDone,
      smooth,
      unstable_transforms: transforms,
    });
  }, [isDone, smooth, source, store, transforms]);

  return isDone || !smooth ? snapshot : deferredSnapshot;
}
