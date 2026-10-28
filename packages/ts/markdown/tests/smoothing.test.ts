import { afterEach, describe, expect, it, vi } from "vitest";

import { createMistralMarkdownReactStore } from "../src/react-store.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("createMistralMarkdownReactStore", () => {
  it("animates connected updates on ticks", async () => {
    vi.useFakeTimers();

    const session = createMistralMarkdownReactStore("Hello", {
      isDone: false,
      smooth: true,
    });
    const listener = vi.fn();
    session.subscribe(listener);
    session.connect();
    session.update("Hello", {
      isDone: false,
      smooth: true,
    });

    const firstSnapshot = session.getSnapshot();

    expect(firstSnapshot.sourceLength).toBe(5);
    expect(firstSnapshot.finalized).toBe(false);

    session.update("Hello world", {
      isDone: false,
      smooth: true,
    });

    expect(session.getSnapshot().sourceLength).toBe(5);

    await vi.advanceTimersByTimeAsync(48);

    expect(listener).toHaveBeenCalled();
    expect(session.getSnapshot().sourceLength).toBeGreaterThan(
      firstSnapshot.sourceLength,
    );

    session.destroy();
  });

  it("publishes complete input immediately when done", () => {
    vi.useFakeTimers();

    const session = createMistralMarkdownReactStore("", {
      isDone: false,
      smooth: true,
    });
    const source = "**bold**";

    session.update(source, {
      isDone: true,
      smooth: true,
    });

    expect(session.getSnapshot()).toMatchObject({
      finalized: true,
      sourceLength: source.length,
      ast: {
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "strong",
                children: [
                  {
                    type: "text",
                    value: "bold",
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    session.destroy();
  });

  it("finalizes immediately when done arrives after the visible source caught up", async () => {
    vi.useFakeTimers();

    const session = createMistralMarkdownReactStore("", {
      isDone: false,
      smooth: true,
    });
    const source = "Hello";
    session.subscribe(() => {});

    session.update(source, {
      isDone: false,
      smooth: true,
    });
    await vi.advanceTimersByTimeAsync(200);

    expect(session.getSnapshot().finalized).toBe(false);

    session.update(source, {
      isDone: true,
      smooth: true,
    });
    const finalizedSnapshot = session.getSnapshot();

    expect(finalizedSnapshot.finalized).toBe(true);
    expect(finalizedSnapshot.sourceLength).toBe(source.length);

    session.destroy();
  });

  it("can finalize an empty stream", () => {
    vi.useFakeTimers();

    const session = createMistralMarkdownReactStore("", {
      isDone: true,
      smooth: true,
    });

    expect(session.getSnapshot()).toMatchObject({
      finalized: true,
      sourceLength: 0,
    });

    session.destroy();
  });

  it("parses complete input immediately when done from the start", () => {
    vi.useFakeTimers();

    const session = createMistralMarkdownReactStore("**Hello**", {
      isDone: true,
      smooth: true,
    });
    const snapshot = session.getSnapshot();

    expect(snapshot).toMatchObject({
      finalized: true,
      sourceLength: 9,
      ast: {
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "strong",
                children: [
                  {
                    type: "text",
                    value: "Hello",
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    session.destroy();
  });

  it("does not notify subscribers for a complete first update", async () => {
    vi.useFakeTimers();

    const session = createMistralMarkdownReactStore("Hello world", {
      isDone: true,
      smooth: true,
    });
    const listener = vi.fn();

    session.subscribe(listener);

    await vi.advanceTimersByTimeAsync(64);

    expect(listener).not.toHaveBeenCalled();

    session.destroy();
  });

  it("catches up faster when the backlog is large", async () => {
    vi.useFakeTimers();

    const shortSession = createMistralMarkdownReactStore("x", {
      isDone: false,
      smooth: true,
    });
    const longSession = createMistralMarkdownReactStore("x", {
      isDone: false,
      smooth: true,
    });
    shortSession.subscribe(() => {});
    longSession.subscribe(() => {});
    shortSession.connect();
    longSession.connect();
    shortSession.update("x", {
      isDone: false,
      smooth: true,
    });
    longSession.update("x", {
      isDone: false,
      smooth: true,
    });
    shortSession.update("x".repeat(20), {
      isDone: false,
      smooth: true,
    });
    longSession.update("x".repeat(200), {
      isDone: false,
      smooth: true,
    });

    await vi.advanceTimersByTimeAsync(48);

    expect(longSession.getSnapshot().sourceLength).toBeGreaterThan(
      shortSession.getSnapshot().sourceLength,
    );

    shortSession.destroy();
    longSession.destroy();
  });

  it("uses a slow typewriter pace for connected updates", async () => {
    vi.useFakeTimers();

    const session = createMistralMarkdownReactStore("x", {
      isDone: false,
      smooth: true,
    });
    session.subscribe(() => {});
    session.connect();
    session.update("x", {
      isDone: false,
      smooth: true,
    });
    session.update("x".repeat(20), {
      isDone: false,
      smooth: true,
    });

    await vi.advanceTimersByTimeAsync(48);

    expect(session.getSnapshot().sourceLength).toBeLessThanOrEqual(6);

    session.destroy();
  });

  it("does not split surrogate pairs", () => {
    vi.useFakeTimers();

    const session = createMistralMarkdownReactStore("", {
      isDone: false,
      smooth: true,
    });
    session.subscribe(() => {});
    session.connect();
    session.update("", {
      isDone: false,
      smooth: true,
    });
    session.update("😀x", {
      isDone: false,
      smooth: true,
    });

    expect(session.getSnapshot().sourceLength).toBe(2);

    session.destroy();
  });

  it("resets when the source no longer extends the visible prefix", () => {
    vi.useFakeTimers();

    const session = createMistralMarkdownReactStore("First message", {
      isDone: false,
      smooth: true,
    });

    session.update("Next", {
      isDone: false,
      smooth: true,
    });
    const resetSnapshot = session.getSnapshot();

    expect(resetSnapshot.sourceLength).toBe(1);
    expect(resetSnapshot.ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "N",
            },
          ],
        },
      ],
    });

    session.destroy();
  });

  it("renders the latest source while disconnected", () => {
    vi.useFakeTimers();

    const session = createMistralMarkdownReactStore("I", {
      isDone: false,
      smooth: true,
    });
    const source =
      "I need to inspect the repository and then make the smallest coherent change.";

    session.render(source, {
      isDone: false,
      smooth: true,
    });

    expect(session.getSnapshot()).toMatchObject({
      finalized: false,
      sourceLength: source.length,
    });

    session.destroy();
  });

  it("catches up after reconnect and streams later connected updates", async () => {
    vi.useFakeTimers();

    const session = createMistralMarkdownReactStore("I", {
      isDone: false,
      smooth: true,
    });
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);
    session.connect();

    session.update("I", {
      isDone: false,
      smooth: true,
    });
    session.disconnect();
    unsubscribe();

    const source =
      "I need to inspect the repository and then make the smallest coherent change.";
    session.render(source, {
      isDone: false,
      smooth: true,
    });
    session.subscribe(listener);
    session.connect();
    session.update(source, {
      isDone: false,
      smooth: true,
    });

    expect(session.getSnapshot()).toMatchObject({
      finalized: false,
      sourceLength: source.length,
      ast: {
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                value: source,
              },
            ],
          },
        ],
      },
    });

    listener.mockClear();
    const nextSource = `${source} Then keep streaming.`;
    session.update(nextSource, {
      isDone: false,
      smooth: true,
    });

    expect(session.getSnapshot()).toMatchObject({
      finalized: false,
      sourceLength: source.length,
    });

    await vi.advanceTimersByTimeAsync(64);

    expect(listener).toHaveBeenCalled();
    expect(session.getSnapshot()).toMatchObject({
      finalized: false,
    });
    expect(session.getSnapshot().sourceLength).toBeGreaterThan(source.length);

    session.destroy();
  });

  it("stops ticking after destroy", async () => {
    vi.useFakeTimers();

    const session = createMistralMarkdownReactStore("Hello world", {
      isDone: false,
      smooth: true,
    });
    const listener = vi.fn();

    session.subscribe(listener);
    session.destroy();

    await vi.advanceTimersByTimeAsync(64);

    expect(listener).not.toHaveBeenCalled();
  });

  it("stops ticking when the last subscriber unsubscribes", async () => {
    vi.useFakeTimers();

    const session = createMistralMarkdownReactStore("Hello world", {
      isDone: false,
      smooth: true,
    });
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);

    unsubscribe();

    await vi.advanceTimersByTimeAsync(64);

    expect(listener).not.toHaveBeenCalled();

    session.destroy();
  });
});
