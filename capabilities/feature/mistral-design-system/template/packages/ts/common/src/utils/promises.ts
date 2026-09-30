/**
 * Creates a promise that resolves after a specified delay.
 *
 * @param ms - The number of milliseconds to delay.
 * @returns A promise that resolves after the given number of milliseconds.
 *
 * @example
 * ```ts
 * // Add a delay before retrying
 * await delay(1000);
 * await retryOperation();
 * ```
 *
 * @example
 * ```ts
 * // Use in async/await
 * async function processWithDelay() {
 *   await delay(500);
 *   console.log("Processed after 500ms");
 * }
 * ```
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A timeout error coming from the `withTimeout` function.
 */
export class TimeoutError extends Error {
  name = "TimeoutError";
  constructor(timeoutMs: number) {
    super(`Promise timed out after ${timeoutMs}ms`);
  }
}

export type TimeoutResult<TReturn> =
  | { status: "completed"; value: TReturn }
  | { status: "timed_out"; timeoutMs: number };

type TimeoutContext = {
  abortController: AbortController;
};

/**
 * Wraps a promise and returns a new promise that will timeout after a given number of milliseconds.
 *
 * @param timeoutMs - The number of milliseconds to wait before timing out.
 * @param promise - The promise to wrap.
 * @param abortController - An optional abort controller to abort the promise if it times out.
 * @returns A promise that will resolve or reject with the same value as the wrapped promise, or reject with a `TimeoutError` if the promise times out.
 */
export async function withTimeout<TReturn>(
  timeoutMs: number,
  promise: Promise<TReturn>,
  abortController?: AbortController,
): Promise<TReturn> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      abortController?.abort();
      reject(new TimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Wraps an async function so timeout handling is part of its return type.
 *
 * Non-timeout failures still reject as normal. Only the timeout branch is
 * converted into a discriminated union result.
 */
export function withTimeoutResult<Args extends readonly unknown[], TReturn>(
  timeoutMs: number,
  fn: (context: TimeoutContext, ...args: Args) => Promise<TReturn>,
): (...args: Args) => Promise<TimeoutResult<TReturn>> {
  return async (...args): Promise<TimeoutResult<TReturn>> => {
    const abortController = new AbortController();
    const result = Promise.withResolvers<TimeoutResult<TReturn>>();
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;

      settled = true;
      abortController.abort();
      result.resolve({ status: "timed_out", timeoutMs });
    }, timeoutMs);

    let operation: Promise<TReturn>;
    try {
      operation = Promise.resolve(fn({ abortController }, ...args));
    } catch (error) {
      settled = true;
      clearTimeout(timeout);
      result.reject(error);
      return result.promise;
    }

    void operation.then(
      (value) => {
        if (settled) return;

        settled = true;
        clearTimeout(timeout);
        result.resolve({ status: "completed", value });
      },
      (error: unknown) => {
        if (settled) return;

        settled = true;
        clearTimeout(timeout);
        result.reject(error);
      },
    );

    return result.promise;
  };
}

/**
 * Wraps an async function so concurrent callers share the same in-flight
 * promise instead of starting duplicate work.
 */
export function singleInFlight<Args extends readonly unknown[], Return>(
  fn: (...args: Args) => Promise<Return>,
): (...args: Args) => Promise<Return> {
  let inFlight: Promise<Return> | null = null;

  return (...args): Promise<Return> => {
    if (inFlight !== null) {
      return inFlight;
    }

    const current = Promise.resolve().then(() => fn(...args));
    inFlight = current;

    const reset = () => {
      if (inFlight === current) {
        inFlight = null;
      }
    };
    void current.then(reset, reset);

    return current;
  };
}

/**
 * Wraps an async function so every call runs after the previous call settles.
 *
 * Each caller receives its own execution and result. A rejected call does not
 * prevent later calls from running.
 */
export function serializePromises<Args extends readonly unknown[], Return>(
  fn: (...args: Args) => Promise<Return>,
): (...args: Args) => Promise<Return> {
  let previous: Promise<unknown> = Promise.resolve();

  return (...args): Promise<Return> => {
    const current = previous.then(() => fn(...args));
    previous = current.catch(() => undefined);
    return current;
  };
}

/**
 * This function ensures there's a single instance of a given effectful function
 * running at a time. If the function is called while it's already running,
 * the arguments are combined and the function is called again with the combined
 * arguments.
 */
export function oneAtATime<Args extends readonly unknown[], Return>(
  fn: (...args: Args) => Promise<Return>,
  combineArgs: (args: Args, nextArgs: Args) => Args = (_, newArgs) => newArgs,
): (...args: Args) => Promise<Return> {
  let state:
    | { type: "running" }
    | {
        type: "pending";
        nextArgs: Args;
        promiseResolvers: PromiseWithResolvers<Return>;
      }
    | { type: "idle" } = { type: "idle" };

  const onFinally = () => {
    if (state.type === "idle") {
      return;
    }

    if (state.type === "running") {
      state = { type: "idle" };
      return;
    }

    const { promiseResolvers, nextArgs } = state;
    state = { type: "running" };

    void Promise.resolve()
      .then(() => fn(...nextArgs))
      .then(promiseResolvers.resolve, promiseResolvers.reject)
      .finally(onFinally);
  };

  return (...args): Promise<Return> => {
    if (state.type === "pending") {
      state.nextArgs = combineArgs(state.nextArgs, args);
      return state.promiseResolvers.promise;
    }

    if (state.type === "running") {
      state = {
        type: "pending",
        nextArgs: args,
        promiseResolvers: Promise.withResolvers<Return>(),
      };
      return state.promiseResolvers.promise;
    }

    state = { type: "running" };
    return Promise.resolve()
      .then(() => fn(...args))
      .finally(onFinally);
  };
}
