import {
  appendMarkdownChunk,
  createInitialMarkdownResult,
  finalizeMarkdownResult,
} from "./parse";
import {
  applyMarkdownTransforms,
  createMarkdownTransformPlan,
} from "./post-process";
import type {
  InternalMarkdownResult,
  MarkdownOptions,
  MarkdownSession,
  MarkdownSnapshot,
} from "./types";

const IS_HERMES_RUNTIME =
  typeof (globalThis as { HermesInternal?: unknown }).HermesInternal !==
  "undefined";

export function createMarkdownSession(
  options?: MarkdownOptions,
): MarkdownSession {
  let result: InternalMarkdownResult = createInitialMarkdownResult();
  const transformPlan = createMarkdownTransformPlan(
    options?.unstable_transforms,
  );
  let publishedSnapshot: MarkdownSnapshot = applyMarkdownTransforms(
    result.snapshot,
    transformPlan,
  );
  let lastRequestedSource = "";
  let lastRequestedDone = false;

  return {
    parse(source: string, isDone = false) {
      if (source === lastRequestedSource && isDone === lastRequestedDone) {
        return publishedSnapshot;
      }

      if (!isDone && result.snapshot.finalized) {
        result = createInitialMarkdownResult();
      }

      if (source !== result.state.source) {
        /* oxlint-disable typescript-eslint/prefer-string-starts-ends-with -- V8 is much faster on the substring equality path for accumulated streaming input. */
        if (
          !result.snapshot.finalized &&
          source.length >= result.state.source.length &&
          (IS_HERMES_RUNTIME
            ? source.startsWith(result.state.source)
            : source.substring(0, result.state.source.length) ===
              result.state.source)
        ) {
          const chunk = source.slice(result.state.source.length);

          if (chunk.length > 0) {
            result = appendMarkdownChunk(result, chunk, source);
          }
        } else {
          result = createInitialMarkdownResult();

          if (source.length > 0) {
            result = appendMarkdownChunk(result, source);
          }
        }
        /* oxlint-enable typescript-eslint/prefer-string-starts-ends-with */
      }

      if (isDone && !result.snapshot.finalized) {
        result = finalizeMarkdownResult(result);
      }

      publishedSnapshot = applyMarkdownTransforms(
        result.snapshot,
        transformPlan,
      );
      lastRequestedSource = source;
      lastRequestedDone = isDone;

      return publishedSnapshot;
    },
  };
}
