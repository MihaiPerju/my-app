import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emitThrottledPatches } from "./emit-throttled-patches";
import { apply, type Patch } from "./patch";

type State = {
  count: number;
  message: string;
};

type StateRootPatch = {
  op: "replace";
  path: "/";
  value: State;
};

const isStateRootPatch = (
  patch: Patch<State> | undefined,
): patch is StateRootPatch => {
  return patch?.op === "replace" && patch.path === "/";
};

const applyPatchBatches = (
  initialState: State | undefined,
  patchBatches: Patch<State>[][],
): State | undefined => {
  return patchBatches.reduce<State | undefined>((state, patches) => {
    if (state === undefined) {
      const rootPatch = patches[0];
      expect(isStateRootPatch(rootPatch)).toBe(true);
      return isStateRootPatch(rootPatch) ? rootPatch.value : state;
    }

    return apply(state, patches);
  }, initialState);
};

describe("emitThrottledPatches", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits the first state immediately as a root patch", () => {
    const onTrigger = vi.fn<(patches: Patch<State>[]) => void>();
    const emit = emitThrottledPatches<State>(10, onTrigger);

    emit({ count: 1, message: "Hello" });

    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(onTrigger).toHaveBeenCalledWith([
      { op: "replace", path: "/", value: { count: 1, message: "Hello" } },
    ]);
  });

  it("collapses pending states into one trailing patch batch", () => {
    const patchBatches: Patch<State>[][] = [];
    const emit = emitThrottledPatches<State>(10, (patches) => {
      patchBatches.push(patches);
    });

    emit({ count: 1, message: "Hello" });
    emit({ count: 2, message: "Hello W" });
    emit({ count: 3, message: "Hello World" });

    expect(patchBatches).toHaveLength(1);

    vi.advanceTimersByTime(9);
    expect(patchBatches).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(patchBatches).toHaveLength(2);
    expect(applyPatchBatches(undefined, patchBatches)).toEqual({
      count: 3,
      message: "Hello World",
    });
  });

  it("emits immediately again when the throttle window has elapsed", () => {
    const patchBatches: Patch<State>[][] = [];
    const emit = emitThrottledPatches<State>(10, (patches) => {
      patchBatches.push(patches);
    });

    emit({ count: 1, message: "Hello" });
    vi.advanceTimersByTime(10);
    emit({ count: 2, message: "Hello!" });

    expect(patchBatches).toHaveLength(2);
    expect(applyPatchBatches(undefined, patchBatches)).toEqual({
      count: 2,
      message: "Hello!",
    });
  });

  it("flushes the latest pending state immediately", () => {
    const patchBatches: Patch<State>[][] = [];
    const emit = emitThrottledPatches<State>(10, (patches) => {
      patchBatches.push(patches);
    });

    emit({ count: 1, message: "Hello" });
    emit({ count: 2, message: "Hello!" });
    emit.flush();

    expect(patchBatches).toHaveLength(2);
    expect(applyPatchBatches(undefined, patchBatches)).toEqual({
      count: 2,
      message: "Hello!",
    });

    vi.advanceTimersByTime(10);
    expect(patchBatches).toHaveLength(2);
  });

  it("does not trigger when flushing without a pending state", () => {
    const onTrigger = vi.fn<(patches: Patch<State>[]) => void>();
    const emit = emitThrottledPatches<State>(10, onTrigger);

    emit.flush();
    emit.flush();

    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("does not trigger for unchanged states", () => {
    const patchBatches: Patch<State>[][] = [];
    const emit = emitThrottledPatches<State>(10, (patches) => {
      patchBatches.push(patches);
    });

    emit({ count: 1, message: "Hello" });
    emit({ count: 1, message: "Hello" });
    vi.advanceTimersByTime(10);

    expect(patchBatches).toHaveLength(1);
    expect(applyPatchBatches(undefined, patchBatches)).toEqual({
      count: 1,
      message: "Hello",
    });
  });

  it("requires a defined state", () => {
    const emit = emitThrottledPatches<State>(10, () => {});

    // @ts-expect-error - undefined states must be filtered before emitting.
    emit(undefined);
  });

  it("uses the latest pending state, not intermediate states, when diffing trailing patches", () => {
    const patchBatches: Patch<State>[][] = [];
    const emit = emitThrottledPatches<State>(10, (patches) => {
      patchBatches.push(patches);
    });

    emit({ count: 1, message: "Hello" });
    emit({ count: 2, message: "Hello " });
    emit({ count: 3, message: "Hello world" });
    vi.advanceTimersByTime(10);

    expect(patchBatches).toEqual([
      [{ op: "replace", path: "/", value: { count: 1, message: "Hello" } }],
      expect.arrayContaining([
        { op: "replace", path: "/count", value: 3 },
        { op: "append", path: "/message", value: " world" },
      ]),
    ]);
    expect(applyPatchBatches(undefined, patchBatches)).toEqual({
      count: 3,
      message: "Hello world",
    });
  });

  it("does not advance the emitted baseline when the callback throws", () => {
    const error = new Error("Could not send patches");
    const patchBatches: Patch<State>[][] = [];
    const onTrigger = vi
      .fn<(patches: Patch<State>[]) => void>()
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockImplementation((patches) => {
        patchBatches.push(patches);
      });
    const emit = emitThrottledPatches<State>(10, onTrigger);

    expect(() => emit({ count: 1, message: "Hello" })).toThrow(error);

    vi.advanceTimersByTime(10);
    emit({ count: 2, message: "Hello!" });

    expect(patchBatches).toEqual(
      [{ count: 2, message: "Hello!" }].map((value) => [
        { op: "replace", path: "/", value },
      ]),
    );
    expect(applyPatchBatches(undefined, patchBatches)).toEqual({
      count: 2,
      message: "Hello!",
    });
  });

  it("does not advance the emitted baseline when a trailing callback throws", () => {
    const error = new Error("Could not send trailing patches");
    const patchBatches: Patch<State>[][] = [];
    const onTrigger = vi
      .fn<(patches: Patch<State>[]) => void>()
      .mockImplementationOnce((patches) => {
        patchBatches.push(patches);
      })
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockImplementation((patches) => {
        patchBatches.push(patches);
      });
    const emit = emitThrottledPatches<State>(10, onTrigger);

    emit({ count: 1, message: "Hello" });
    emit({ count: 2, message: "Hello!" });
    expect(() => vi.advanceTimersByTime(10)).toThrow(error);

    vi.advanceTimersByTime(10);
    emit({ count: 3, message: "Hello!!" });

    expect(patchBatches).toEqual([
      [{ op: "replace", path: "/", value: { count: 1, message: "Hello" } }],
      expect.arrayContaining([
        { op: "replace", path: "/count", value: 3 },
        { op: "append", path: "/message", value: "!!" },
      ]),
    ]);
    expect(applyPatchBatches(undefined, patchBatches)).toEqual({
      count: 3,
      message: "Hello!!",
    });
  });

  it("emits every defined state immediately when throttle is zero", () => {
    const patchBatches: Patch<State>[][] = [];
    const emit = emitThrottledPatches<State>(0, (patches) => {
      patchBatches.push(patches);
    });

    emit({ count: 1, message: "a" });
    emit({ count: 2, message: "ab" });
    emit({ count: 3, message: "abc" });

    expect(patchBatches).toHaveLength(3);
    expect(applyPatchBatches(undefined, patchBatches)).toEqual({
      count: 3,
      message: "abc",
    });
  });

  it("treats negative throttle values like zero", () => {
    const patchBatches: Patch<State>[][] = [];
    const emit = emitThrottledPatches<State>(-10, (patches) => {
      patchBatches.push(patches);
    });

    emit({ count: 1, message: "a" });
    emit({ count: 2, message: "ab" });

    expect(patchBatches).toHaveLength(2);
    expect(applyPatchBatches(undefined, patchBatches)).toEqual({
      count: 2,
      message: "ab",
    });
  });

  it("supports literal states", () => {
    const patchBatches: Patch<number>[][] = [];
    const emit = emitThrottledPatches<number>(10, (patches) => {
      patchBatches.push(patches);
    });

    emit(1);
    emit(2);
    vi.advanceTimersByTime(10);

    expect(patchBatches).toEqual([
      [{ op: "replace", path: "/", value: 1 }],
      [{ op: "replace", path: "/", value: 2 }],
    ]);
  });

  it("keeps reconstructed clients aligned with the last emitted state across windows", () => {
    const patchBatches: Patch<State>[][] = [];
    const emit = emitThrottledPatches<State>(10, (patches) => {
      patchBatches.push(patches);
    });

    emit({ count: 1, message: "" });
    emit({ count: 2, message: "a" });
    vi.advanceTimersByTime(10);

    emit({ count: 3, message: "ab" });
    vi.advanceTimersByTime(5);
    emit({ count: 4, message: "abc" });
    vi.advanceTimersByTime(5);

    emit({ count: 5, message: "abcd" });
    emit.flush();

    expect(applyPatchBatches(undefined, patchBatches)).toEqual({
      count: 5,
      message: "abcd",
    });
  });
});
