import { createEvent, fireEvent, renderHook } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HotkeyCallback, Key, Options } from "./types";
import useHotkey from "./use-hotkey";

type HookParameters = {
  key: Key;
  callback?: HotkeyCallback;
  options?: Options;
};

describe("useHotKey", () => {
  let user: ReturnType<typeof userEvent.setup>;
  let callback: HotkeyCallback;

  beforeEach(() => {
    window.dispatchEvent(new Event("DOMContentLoaded"));
    user = userEvent.setup();
    callback = vi.fn<HotkeyCallback>();
  });

  it("listens to key presses", async () => {
    renderHook(() => useHotkey("a", callback));

    await user.keyboard("A");

    expect(callback).toHaveBeenCalledOnce();
  });

  it("ignores unregistered key events", async () => {
    renderHook(() => useHotkey("a", callback));

    await user.keyboard("B");

    expect(callback).not.toHaveBeenCalled();
  });

  it("listens to esc modifier for escape key", async () => {
    renderHook(() => useHotkey("esc", callback));

    await user.keyboard("{Escape}");

    expect(callback).toHaveBeenCalledOnce();
  });

  it("always outputs correct key on multiple hotkey", async () => {
    const callbackA = vi.fn();
    const callbackB = vi.fn();

    renderHook(() => useHotkey("a", callbackA));
    renderHook(() => useHotkey("b", callbackB));

    await user.keyboard("{A>}");

    expect(callbackA).toHaveBeenCalledOnce();

    await user.keyboard("B");
    expect(callbackA).toHaveBeenCalledOnce();
    expect(callbackB).toHaveBeenCalledOnce();

    await user.keyboard("C");

    expect(callbackA).toHaveBeenCalledOnce();
    expect(callbackB).toHaveBeenCalledOnce();

    await user.keyboard("B");
    expect(callbackA).toHaveBeenCalledOnce();
    expect(callbackB).toHaveBeenCalledTimes(2);

    await user.keyboard("{/A}");
    expect(callbackA).toHaveBeenCalledOnce();
    expect(callbackB).toHaveBeenCalledTimes(2);
  });

  it("listens to combinations with modifiers", async () => {
    const { rerender } = renderHook<void, HookParameters>(
      ({ key }) => useHotkey(key, callback),
      {
        initialProps: {
          key: "meta+a",
        },
      },
    );

    await user.keyboard("{Meta>}A{/Meta}");

    expect(callback).toHaveBeenCalledOnce();

    rerender({ key: "meta+shift+a" });

    await user.keyboard("{Meta}A{/Meta}");
    await user.keyboard("{Meta>}{Shift>}A{/Shift}{/Meta}");

    expect(callback).toHaveBeenCalledTimes(2);

    rerender({ key: "meta+shift+alt+a" });

    await user.keyboard("{Meta>}{Alt>}{Shift>}A{/Shift}{/Alt}{/Meta}");

    expect(callback).toHaveBeenCalledTimes(3);
  });

  it("does not trigger when combinations are incomplete", async () => {
    renderHook(() => useHotkey("meta+a", callback));

    await user.keyboard("{Meta}");

    expect(callback).not.toHaveBeenCalled();
  });

  it("triggers on combinations without modifiers", async () => {
    renderHook(() => useHotkey("a+b+c", callback));

    await user.keyboard("{A>}{B>}C{/B}{/A}");

    expect(callback).toHaveBeenCalledOnce();

    await user.keyboard("{A>}B{/A}");

    expect(callback).toHaveBeenCalledOnce();
  });

  it.each([
    "arrowUp",
    "arrowDown",
    "arrowLeft",
    "arrowRight",
    "enter",
    "backspace",
  ])("allows named key %s", async (key) => {
    renderHook(() => useHotkey(key, callback));

    await user.keyboard(`{${key}}`);

    expect(callback).toHaveBeenCalledOnce();
  });

  it("passes keyboard event and hotkey object to callback", async () => {
    renderHook(() => useHotkey("e", callback));

    await user.keyboard("E");

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(expect.any(KeyboardEvent), {
      keys: ["e"],
      shift: false,
      ctrl: false,
      alt: false,
      meta: false,
      mod: false,
    });
  });

  it("sets shift to true in hotkey object if listening to shift", async () => {
    renderHook(() => useHotkey("shift+a", callback));

    await user.keyboard("{Shift>}A{/Shift}");

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(expect.any(KeyboardEvent), {
      keys: ["a"],
      shift: true,
      ctrl: false,
      alt: false,
      meta: false,
      mod: false,
    });
  });

  it("sets ctrl to true in hotkey object if listening to ctrl", async () => {
    renderHook(() => useHotkey("ctrl+a", callback));

    await user.keyboard("{Control>}A{/Control}");

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(expect.any(KeyboardEvent), {
      keys: ["a"],
      shift: false,
      ctrl: true,
      alt: false,
      meta: false,
      mod: false,
    });
  });

  it("sets alt to true in hotkey object if listening to alt", async () => {
    renderHook(() => useHotkey("alt+a", callback));

    await user.keyboard("{Alt>}A{/Alt}");

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(expect.any(KeyboardEvent), {
      keys: ["a"],
      shift: false,
      ctrl: false,
      alt: true,
      meta: false,
      mod: false,
    });
  });

  it("sets mod to true in hotkey object if listening to mod", async () => {
    renderHook(() => useHotkey("mod+a", callback));

    await user.keyboard("{Meta>}A{/Meta}");

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(expect.any(KeyboardEvent), {
      keys: ["a"],
      shift: false,
      ctrl: false,
      alt: false,
      meta: false,
      mod: true,
    });
  });

  it("sets meta to true in hotkey object if listening to meta", async () => {
    renderHook(() => useHotkey("meta+a", callback));

    await user.keyboard("{Meta>}A{/Meta}");

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(expect.any(KeyboardEvent), {
      keys: ["a"],
      shift: false,
      ctrl: false,
      alt: false,
      meta: true,
      mod: false,
    });
  });

  it("sets multiple modifiers to true in hotkey object if listening to multiple modifiers", async () => {
    renderHook(() => useHotkey("mod+shift+a", callback));

    await user.keyboard("{Meta>}{Shift>}A{/Shift}{/Meta}");

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(expect.any(KeyboardEvent), {
      keys: ["a"],
      shift: true,
      alt: false,
      ctrl: false,
      meta: false,
      mod: true,
    });
  });

  it("does not bind the event if isDisabled is set to true", async () => {
    renderHook(() => useHotkey("a", callback, { isDisabled: true }));

    await user.keyboard("A");

    expect(callback).toHaveBeenCalledTimes(0);
  });

  it("binds the event and trigger if isDisabled is set to false", async () => {
    renderHook(() => useHotkey("b", callback, { isDisabled: false }));

    await user.keyboard("B");

    expect(callback).toHaveBeenCalledOnce();
  });

  it("binds the event and trigger if isDisabled is not set", async () => {
    renderHook(() => useHotkey("c", callback));

    await user.keyboard("C");

    expect(callback).toHaveBeenCalledOnce();
  });

  it("prevents default behavior when preventDefault option is set to true", () => {
    renderHook(() => useHotkey("c", callback, { preventDefault: true }));

    const keyDownEvent = createEvent.keyDown(document, {
      key: "C",
    });

    fireEvent(document, keyDownEvent);

    expect(callback).toHaveBeenCalledOnce();
    expect(keyDownEvent.defaultPrevented).toBe(true);
  });

  it("does not prevent default behavior when preventDefault option is set to false", () => {
    renderHook(() => useHotkey("d", callback, { preventDefault: false }));

    const keyDownEvent = createEvent.keyDown(document, {
      key: "D",
    });

    fireEvent(document, keyDownEvent);

    expect(callback).toHaveBeenCalledOnce();
    expect(keyDownEvent.defaultPrevented).toBe(false);
  });

  it("does not prevent default behavior when preventDefault option is not set", () => {
    renderHook(() => useHotkey("e", callback));

    const keyDownEvent = createEvent.keyDown(document, {
      key: "E",
    });

    fireEvent(document, keyDownEvent);

    expect(callback).toHaveBeenCalledOnce();
    expect(keyDownEvent.defaultPrevented).toBe(false);
  });

  it("handles the keydown event on the capture phase when the capture option is set to true", () => {
    const addEventListenerSpy = vi.spyOn(document, "addEventListener");
    const options = { capture: true };

    renderHook(() => useHotkey("f", callback, options));

    const keyDownEvent = createEvent.keyDown(document, {
      key: "F",
    });

    fireEvent(document, keyDownEvent);

    expect(callback).toHaveBeenCalledOnce();
    expect(addEventListenerSpy).toHaveBeenCalledWith(
      "keydown",
      expect.any(Function),
      expect.objectContaining(options),
    );

    addEventListenerSpy.mockRestore();
  });

  it("can capture on window before a document listener blocks the event", () => {
    const blocker = (event: KeyboardEvent) => event.stopImmediatePropagation();
    document.addEventListener("keydown", blocker, { capture: true });

    renderHook(() =>
      useHotkey("f", callback, {
        capture: true,
        eventTarget: "window",
      }),
    );

    fireEvent.keyDown(document.body, { key: "F" });

    expect(callback).toHaveBeenCalledOnce();
    document.removeEventListener("keydown", blocker, { capture: true });
  });

  it("can stop a captured event before it reaches the target", () => {
    const target = document.createElement("input");
    const targetListener = vi.fn();
    target.addEventListener("keydown", targetListener);
    document.body.append(target);

    renderHook(() =>
      useHotkey("j", callback, {
        capture: true,
        eventTarget: "window",
        stopPropagation: true,
      }),
    );

    fireEvent.keyDown(target, { key: "J" });

    expect(callback).toHaveBeenCalledOnce();
    expect(targetListener).not.toHaveBeenCalled();
    target.remove();
  });

  it("handles the keydown event on the bubbling phase when the capture option is set to false", () => {
    const addEventListenerSpy = vi.spyOn(document, "addEventListener");
    const options = { capture: false };

    renderHook(() => useHotkey("g", callback, options));

    const keyDownEvent = createEvent.keyDown(document, {
      key: "G",
    });

    fireEvent(document, keyDownEvent);

    expect(callback).toHaveBeenCalledOnce();
    expect(addEventListenerSpy).toHaveBeenCalledWith(
      "keydown",
      expect.any(Function),
      expect.objectContaining(options),
    );

    addEventListenerSpy.mockRestore();
  });

  it("handles the keydown event on the bubbling phase when the capture option is not set", () => {
    const addEventListenerSpy = vi.spyOn(document, "addEventListener");

    renderHook(() => useHotkey("h", callback));

    const keyDownEvent = createEvent.keyDown(document, {
      key: "H",
    });

    fireEvent(document, keyDownEvent);

    expect(callback).toHaveBeenCalledOnce();
    expect(addEventListenerSpy).toHaveBeenCalledWith(
      "keydown",
      expect.any(Function),
      expect.objectContaining({ capture: false }),
    );

    addEventListenerSpy.mockRestore();
  });

  it.each(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"])(
    `listens to number key %s`,
    async (key) => {
      renderHook(() => useHotkey(`shift+${key}`, callback));

      await user.keyboard(`{Shift>}${key}{/Shift}`);

      expect(callback).toHaveBeenCalledOnce();
    },
  );

  it("can listen to physical key codes", () => {
    renderHook(() => useHotkey("alt+digit1", callback));

    const keyDownEvent = createEvent.keyDown(document, {
      key: "&",
      code: "Digit1",
      altKey: true,
    });

    fireEvent(document, keyDownEvent);

    expect(callback).toHaveBeenCalledOnce();
  });

  it("updates event listeners when the key and/or options change", () => {
    const addEventListenerSpy = vi.spyOn(document, "addEventListener");
    const removeEventListenerSpy = vi.spyOn(document, "removeEventListener");

    const { rerender } = renderHook(
      ({ key, options }) => useHotkey(key, callback, options),
      { initialProps: { key: "a", options: { capture: false } } },
    );

    rerender({ key: "b", options: { capture: true } });

    expect(removeEventListenerSpy).toHaveBeenCalledWith(
      "keydown",
      expect.any(Function),
      { capture: false },
    );
    expect(removeEventListenerSpy).toHaveBeenCalledWith(
      "keyup",
      expect.any(Function),
      { capture: false },
    );
    expect(addEventListenerSpy).toHaveBeenCalledWith(
      "keydown",
      expect.any(Function),
      { capture: true },
    );
    expect(addEventListenerSpy).toHaveBeenCalledWith(
      "keyup",
      expect.any(Function),
      { capture: true },
    );

    addEventListenerSpy.mockRestore();
    removeEventListenerSpy.mockRestore();
  });

  it("removes event listeners on unmount", () => {
    const addEventListenerSpy = vi.spyOn(document, "addEventListener");
    const removeEventListenerSpy = vi.spyOn(document, "removeEventListener");
    const options = { capture: true };

    const { unmount } = renderHook(() => useHotkey("a", callback, options));

    const addKeyDownCall = addEventListenerSpy.mock.calls.find(
      (call) => call[0] === "keydown",
    );
    const addKeyUpCall = addEventListenerSpy.mock.calls.find(
      (call) => call[0] === "keyup",
    );

    expect(addKeyDownCall).toBeDefined();
    expect(addKeyUpCall).toBeDefined();

    const keyDownHandler = addKeyDownCall?.[1];
    const keyUpHandler = addKeyUpCall?.[1];
    const keyDownOptions = addKeyDownCall?.[2];
    const keyUpOptions = addKeyUpCall?.[2];

    expect(addEventListenerSpy).toHaveBeenCalledWith(
      "keydown",
      keyDownHandler,
      keyDownOptions,
    );
    expect(addEventListenerSpy).toHaveBeenCalledWith(
      "keyup",
      keyUpHandler,
      keyUpOptions,
    );

    unmount();

    expect(removeEventListenerSpy).toHaveBeenCalledWith(
      "keydown",
      keyDownHandler,
      keyDownOptions,
    );
    expect(removeEventListenerSpy).toHaveBeenCalledWith(
      "keyup",
      keyUpHandler,
      keyUpOptions,
    );

    addEventListenerSpy.mockRestore();
    removeEventListenerSpy.mockRestore();
  });

  it("returns null", () => {
    const { result } = renderHook(() => useHotkey("a", callback));

    expect(result.current).toBeNull();
  });

  it("does not register listeners when key is empty string (skip sentinel)", async () => {
    const addEventListenerSpy = vi.spyOn(document, "addEventListener");

    renderHook(() => useHotkey("", callback));

    expect(
      addEventListenerSpy.mock.calls.find((call) => call[0] === "keydown"),
    ).toBeUndefined();
    expect(
      addEventListenerSpy.mock.calls.find((call) => call[0] === "keyup"),
    ).toBeUndefined();

    addEventListenerSpy.mockRestore();

    await user.keyboard("A");

    expect(callback).not.toHaveBeenCalled();
  });

  it("fires mod hotkey on ctrl press (non-mac path)", async () => {
    renderHook(() => useHotkey("mod+a", callback));

    await user.keyboard("{Control>}A{/Control}");

    expect(callback).toHaveBeenCalledOnce();
  });

  it("listens on window target", () => {
    const addEventListenerSpy = vi.spyOn(window, "addEventListener");

    renderHook(() => useHotkey("k", callback, { eventTarget: "window" }));

    fireEvent.keyDown(document.body, { key: "K" });

    expect(callback).toHaveBeenCalledOnce();
    expect(addEventListenerSpy).toHaveBeenCalledWith(
      "keydown",
      expect.any(Function),
      expect.any(Object),
    );

    addEventListenerSpy.mockRestore();
  });

  it("stops propagation in bubbling phase", () => {
    const windowListener = vi.fn();
    window.addEventListener("keydown", windowListener);

    renderHook(() => useHotkey("k", callback, { stopPropagation: true }));

    const keyDownEvent = createEvent.keyDown(document, { key: "K" });
    fireEvent(document, keyDownEvent);

    expect(callback).toHaveBeenCalledOnce();
    expect(windowListener).not.toHaveBeenCalled();

    window.removeEventListener("keydown", windowListener);
  });
});
