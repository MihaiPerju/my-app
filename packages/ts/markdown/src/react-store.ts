import { createMarkdownSession } from "./session";
import type {
  MarkdownOptions,
  MarkdownSnapshot,
  UnstableMarkdownTransform,
} from "./types";

export type MistralMarkdownReactOptions = MarkdownOptions & {
  /** Marks whether the source is final. `false` enables optimistic parsing. */
  readonly isDone?: boolean;
  /** Enables typewriter-style source reveal while `isDone` is false. */
  readonly smooth?: boolean;
};

type ResolvedMistralMarkdownReactOptions = {
  readonly isDone: boolean;
  readonly smooth: boolean;
  readonly unstable_transforms?: readonly UnstableMarkdownTransform[];
};

export type MistralMarkdownReactStore = {
  connect(): void;
  disconnect(): void;
  destroy(): void;
  getSnapshot(): MarkdownSnapshot;
  /** Ingests the latest render input without starting smoothing timers. */
  render(
    source: string,
    options: ResolvedMistralMarkdownReactOptions,
  ): MarkdownSnapshot;
  subscribe(listener: () => void): () => void;
  update(source: string, options: ResolvedMistralMarkdownReactOptions): void;
};

const MIN_STREAMING_CHARACTERS_PER_SECOND = 32;
const BACKLOG_RATE_MULTIPLIER = 5;
const MAX_STREAMING_DELAY_MS = 40;
const MIN_STREAMING_DELAY_MS = 12;

export function createMistralMarkdownReactStore(
  initialSource: string,
  initialOptions: ResolvedMistralMarkdownReactOptions,
): MistralMarkdownReactStore {
  let cancelScheduledTick: (() => void) | null = null;
  let connected = false;
  let destroyed = false;
  let parser = createMarkdownSession(
    createMarkdownOptions(initialOptions.unstable_transforms),
  );
  let targetSource = initialSource;
  let visibleSource = initialSource;
  let previousSource = initialSource;
  let previousIsDone = initialOptions.isDone;
  let previousSmooth = initialOptions.smooth;
  let previousTransforms = initialOptions.unstable_transforms;
  let snapshot = parser.parse(visibleSource, initialOptions.isDone);
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  function publish(nextSnapshot: MarkdownSnapshot): void {
    if (snapshot === nextSnapshot) {
      return;
    }

    snapshot = nextSnapshot;
    emit();
  }

  function cancelTick(): void {
    if (cancelScheduledTick === null) {
      return;
    }

    cancelScheduledTick();
    cancelScheduledTick = null;
  }

  function resetParser(
    transforms: readonly UnstableMarkdownTransform[] | undefined,
  ): void {
    cancelTick();
    parser = createMarkdownSession(createMarkdownOptions(transforms));
    previousTransforms = transforms;
    targetSource = "";
    visibleSource = "";
    previousSource = "";
    previousIsDone = true;
    previousSmooth = false;
    snapshot = parser.parse("", true);
  }

  function reveal(characterCount: number): boolean {
    if (visibleSource.length >= targetSource.length) {
      return false;
    }

    visibleSource = targetSource.slice(
      0,
      offsetAfterCodePoints(targetSource, visibleSource.length, characterCount),
    );
    snapshot = parser.parse(visibleSource, false);

    return true;
  }

  function scheduleNextTick(): void {
    if (
      destroyed ||
      cancelScheduledTick !== null ||
      !connected ||
      listeners.size === 0 ||
      !previousSmooth ||
      previousIsDone ||
      visibleSource.length >= targetSource.length
    ) {
      return;
    }

    const charactersPerSecond =
      MIN_STREAMING_CHARACTERS_PER_SECOND +
      (targetSource.length - visibleSource.length) * BACKLOG_RATE_MULTIPLIER;
    const characterCount = Math.max(1, Math.floor(charactersPerSecond / 240));
    const delayMs = Math.max(
      MIN_STREAMING_DELAY_MS,
      Math.min(MAX_STREAMING_DELAY_MS, Math.round(1_000 / charactersPerSecond)),
    );

    cancelScheduledTick = scheduleTick(() => {
      cancelScheduledTick = null;

      if (destroyed) {
        return;
      }

      if (reveal(characterCount)) {
        emit();
      }

      scheduleNextTick();
    }, delayMs);
  }

  return {
    connect() {
      if (destroyed) {
        return;
      }

      connected = true;
      scheduleNextTick();
    },
    disconnect() {
      connected = false;
      cancelTick();
    },
    destroy() {
      destroyed = true;
      connected = false;
      listeners.clear();
      cancelTick();
    },
    getSnapshot() {
      return snapshot;
    },
    subscribe(listener: () => void) {
      if (destroyed) {
        return () => {};
      }

      listeners.add(listener);
      scheduleNextTick();

      return () => {
        listeners.delete(listener);

        if (listeners.size === 0) {
          cancelTick();
        }
      };
    },
    render(source, options) {
      if (destroyed) {
        return snapshot;
      }

      if (connected && options.smooth && !options.isDone) {
        return snapshot;
      }

      if (options.unstable_transforms !== previousTransforms) {
        resetParser(options.unstable_transforms);
      }

      if (
        source === previousSource &&
        options.isDone === previousIsDone &&
        options.smooth === previousSmooth
      ) {
        return snapshot;
      }

      previousSource = source;
      previousIsDone = options.isDone;
      previousSmooth = options.smooth;
      cancelTick();
      targetSource = source;
      visibleSource = source;
      snapshot = parser.parse(source, options.isDone);

      return snapshot;
    },
    update(source, options) {
      if (destroyed) {
        return;
      }

      if (options.unstable_transforms !== previousTransforms) {
        resetParser(options.unstable_transforms);
      }

      if (
        source === previousSource &&
        options.isDone === previousIsDone &&
        options.smooth === previousSmooth
      ) {
        return;
      }

      previousSource = source;
      previousIsDone = options.isDone;
      previousSmooth = options.smooth;

      if (!options.smooth || options.isDone) {
        cancelTick();
        targetSource = source;
        visibleSource = source;
        publish(parser.parse(source, options.isDone));
        return;
      }

      if (!source.startsWith(visibleSource)) {
        parser = createMarkdownSession(
          createMarkdownOptions(options.unstable_transforms),
        );
        visibleSource = "";
        snapshot = parser.parse("", false);
      }

      targetSource = source;

      if (visibleSource.length === 0 && targetSource.length > 0) {
        reveal(1);
        emit();
      }

      scheduleNextTick();
    },
  };
}

function createMarkdownOptions(
  transforms: readonly UnstableMarkdownTransform[] | undefined,
): MarkdownOptions | undefined {
  if (transforms === undefined) {
    return undefined;
  }

  return {
    unstable_transforms: transforms,
  };
}

function scheduleTick(callback: () => void, delayMs: number): () => void {
  const id = setTimeout(callback, delayMs);

  return () => clearTimeout(id);
}

function offsetAfterCodePoints(
  source: string,
  startOffset: number,
  count: number,
): number {
  let offset = startOffset;
  let advanced = 0;

  while (offset < source.length && advanced < count) {
    const codeUnit = source.charCodeAt(offset);

    if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      offset + 1 < source.length
    ) {
      const nextCodeUnit = source.charCodeAt(offset + 1);

      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        offset += 2;
        advanced += 1;
        continue;
      }
    }

    offset += 1;
    advanced += 1;
  }

  return offset;
}
