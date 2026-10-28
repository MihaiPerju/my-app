import {
  ALT_LABEL,
  formatShortcut,
  formatShortcutForPlatform,
  getModifierLabels,
  MOD_LABEL,
} from "./key-display";
import { parseHotkey } from "./parse";
import useHotkey from "./use-hotkey";
import { useShortcutDisplay } from "./use-shortcut-display";
import { isHotkeyMatchingKeyboardEvent } from "./validator";

export {
  ALT_LABEL,
  formatShortcut,
  formatShortcutForPlatform,
  getModifierLabels,
  isHotkeyMatchingKeyboardEvent,
  MOD_LABEL,
  parseHotkey,
  useHotkey,
  useShortcutDisplay,
};

export type {
  Hotkey,
  HotkeyCallback,
  HotkeysEvent,
  Key,
  Options,
  ShortcutDisplay,
} from "./types";
