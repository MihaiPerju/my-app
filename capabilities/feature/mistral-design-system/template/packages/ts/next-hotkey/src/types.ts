/**
 * Represents a reference type that can either be the given type `T` or `null`.
 *
 * @template T - The type of the referenced value.
 */
export type RefType<T> = T | null;

/**
 * Represents the subset of event methods required to fully stop event propagation.
 */
export type StoppableEvent = Pick<
  Event,
  "stopPropagation" | "preventDefault" | "stopImmediatePropagation"
>;

/**
 * Represents a unique key or physical key code used for hotkeys (i.e. keyboard shortcuts).
 */
export type Key = KeyboardEvent["key"];

/**
 * Represents the possible keyboard modifiers that can be held down during a hotkey press.
 */
export type KeyboardModifiers = {
  /**
   * Indicates if the `Alt` key is pressed.
   */
  alt?: boolean;
  /**
   * Indicates if the `Ctrl` key is pressed.
   */
  ctrl?: boolean;
  /**
   * Indicates if the `Meta` key is pressed.
   */
  meta?: boolean;
  /**
   * Indicates if the `Shift` key is pressed.
   */
  shift?: boolean;
  /**
   * Indicates if the `Mod` key (meta on macOS and ctrl on other platforms) is pressed.
   */
  mod?: boolean;
};

/**
 * Represents a normalized hotkey combination, which can include optional keyboard modifiers.
 *
 * @extends KeyboardModifiers - Inherits the modifier flags (alt, ctrl, meta, shift, mod).
 */
export interface Hotkey extends KeyboardModifiers {
  /**
   * A list of keys (excluding the modifiers) that make up the hotkey combination.
   *
   * @example ["a", "b"]
   */
  keys?: readonly Key[];
}

/**
 * Represents an event triggered by a hotkey press.
 */
export type HotkeysEvent = Hotkey;

/**
 * Callback function that handles hotkey events.
 *
 * @param keyboardEvent - The browser's native `KeyboardEvent`.
 * @param hotkeysEvent - The hotkey event triggered.
 */
export type HotkeyCallback = (
  keyboardEvent: KeyboardEvent,
  hotkeysEvent: HotkeysEvent,
) => void;

/**
 * Represents the subset of `AddEventListenerOptions` required for DOM event listeners.
 */
type DOMListenerOptions = Pick<
  AddEventListenerOptions,
  /**
   * Indicates that events of this type will be dispatched to the registered listener
   * before being dispatched to any `EventTarget` beneath it in the DOM tree.
   * @default false
   */
  "capture"
>;

/**
 * Internal options for configuring the behavior.
 */
interface InternalOptions {
  /**
   * Event target used to register the keyboard listeners.
   * @default document
   */
  eventTarget?: "document" | "window";
  /**
   * Determines if the hotkey is disabled or not.
   * @default false
   */
  isDisabled?: boolean;
  /**
   * Determines if the default browser behavior should be prevented.
   * @default false
   */
  preventDefault?: boolean;
  /**
   * Prevents the event from reaching targets below the listener.
   * @default false
   */
  stopPropagation?: boolean;
  /**
   * Character to split keys in hotkeys combinations.
   * @default +
   */
  splitKey?: string;
}

/**
 * Options for configuring the behavior.
 */
export type Options = InternalOptions & DOMListenerOptions;

/**
 * Return type of the `useShortcutDisplay` hook, providing platform-aware
 * labels and a shortcut formatter.
 */
export type ShortcutDisplay = {
  altLabel: string;
  formatShortcut: (...keys: string[]) => string;
  modLabel: string;
};
