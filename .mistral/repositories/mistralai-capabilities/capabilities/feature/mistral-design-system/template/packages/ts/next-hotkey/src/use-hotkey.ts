"use client";

import { useEffect } from "react";
import { useEventCallback } from "usehooks-ts";

import { DEFAULT_OPTIONS } from "./constants";
import { stopEvent } from "./events";
import { normalizeKey, parseHotkey } from "./parse";
import {
  pushToCurrentlyPressedKeys,
  removeFromCurrentlyPressedKeys,
} from "./state";
import type { HotkeyCallback, Key, Options } from "./types";
import useDeepEqualMemo from "./use-deep-equal-memo";
import { isHotkeyMatchingKeyboardEvent } from "./validator";

/**
 * We would never create a hotkey with an empty string so it can
 * be provided as a skip value for the `key` parameter.
 */
const SKIP_HOTKEY_VALUE = "";

/**
 * A React hook that binds a keyboard shortcut (hotkey) to a callback.
 *
 * @param key - The hotkey combination (e.g. `"ctrl+s"`, `"cmd+shift+p"`, etc.).
 * Use an empty string to skip the hotkey.
 * @param callback - A function to call when the hotkey is triggered.
 * @param options - Optional configuration object to control hotkey behavior.
 *
 * @returns `null`
 *
 * @example
 * ```tsx
 * useHotkey("mod+k", () => {
 *   openSearchModal();
 * });
 * ```
 */
export default function useHotkey(
  key: Key,
  callback: HotkeyCallback,
  options: Readonly<Options> = DEFAULT_OPTIONS,
): null {
  const eventCallback = useEventCallback(callback);
  const memoizedOptions = useDeepEqualMemo({ ...options });

  useEffect(() => {
    if (memoizedOptions?.isDisabled || key === SKIP_HOTKEY_VALUE) return;
    const {
      eventTarget,
      preventDefault,
      stopPropagation: shouldStopPropagation,
      isDisabled,
      splitKey,
      ...nativeListenerOptions
    } = memoizedOptions ?? DEFAULT_OPTIONS;

    const hotkey = parseHotkey(key, splitKey);

    const listener = (event: KeyboardEvent) => {
      if (isHotkeyMatchingKeyboardEvent(event, hotkey)) {
        if (preventDefault) {
          event.preventDefault();
        }
        if (shouldStopPropagation) {
          event.stopPropagation();
        }

        if (isDisabled) {
          stopEvent(event);
          return;
        }

        eventCallback(event, hotkey);
      }
    };

    const handleKeyDown = (event: Event) => {
      // Chrome autofill triggers keydown event without KeyboardEvent object, and so without the key property
      if (!(event instanceof KeyboardEvent) || !event.key) return;
      pushToCurrentlyPressedKeys(normalizeKey(event.key));
      listener(event);
    };

    const handleKeyUp = (event: Event) => {
      // Chrome autofill triggers keyup event without KeyboardEvent object, and so without the key property
      if (!(event instanceof KeyboardEvent) || !event.key) return;
      removeFromCurrentlyPressedKeys(normalizeKey(event.key));
    };

    const listenerOptions: AddEventListenerOptions = nativeListenerOptions;
    const listenerTarget = eventTarget === "window" ? window : document;

    listenerTarget.addEventListener("keyup", handleKeyUp, listenerOptions);
    listenerTarget.addEventListener("keydown", handleKeyDown, listenerOptions);

    return () => {
      listenerTarget.removeEventListener("keyup", handleKeyUp, listenerOptions);
      listenerTarget.removeEventListener(
        "keydown",
        handleKeyDown,
        listenerOptions,
      );
    };
  }, [key, memoizedOptions, eventCallback]);

  return null;
}
