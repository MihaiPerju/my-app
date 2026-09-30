/**
 * Self-contained WebSocket session hook with an external-store controller.
 *
 * Reconnect uses bounded exponential backoff and surfaces a terminal error when the budget is spent.
 * Reconnect is safe: each reconnect mints a new server session, and the hook folds the dropped
 * session's text into a committed baseline before each retry, so committed text is never duplicated.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

export type WebSocketSessionState<TData> =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "reconnecting"; data: TData; attempt: number }
  | { status: "open"; data: TData }
  | { status: "closed"; data: TData }
  | { status: "error"; error: Error; data: TData };

export interface WebSocketReducerResult<TData> {
  data: TData;
  done: boolean;
}

/** Mints a fresh transport each (re)connect. Async so a reconnect can re-mint a short-lived token. */
export type WebSocketFactory = () => WebSocket | Promise<WebSocket>;

export interface ReconnectPolicy<TSend, TData> {
  /** Hard cap on consecutive reconnect attempts before a terminal error is surfaced. */
  maxAttempts: number;
  /** Delay before the first retry, in ms. */
  baseMs?: number;
  /** Upper bound on any single retry delay, in ms. */
  capMs?: number;
  /** Exponential growth factor per attempt. */
  factor?: number;
  /** Whether the (re)connected server session has reported itself ready to receive audio. */
  isReady: (data: TData) => boolean;
  /** Runs the instant a drop is detected, before any backoff wait: hold the audio gate so no chunk
   *  reaches the fresh session before its `session.update` does. */
  onReconnecting: () => void;
  /** Fold the dropped session's text into a committed baseline the next session continues from. */
  commit: (data: TData) => TData;
  /** Re-run the post-open handshake on the fresh socket (resend `session.update`, reopen the gate). */
  rehandshake: (send: (message: TSend) => void, data: TData) => void;
}

interface WebSocketSessionConfig<TSend, TReceive, TData> {
  initialData: TData;
  reducer: (data: TData, message: TReceive) => WebSocketReducerResult<TData>;
  reconnect?: ReconnectPolicy<TSend, TData>;
}

interface PromiseWithResolvers<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function promiseWithResolvers<T>(): PromiseWithResolvers<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Full-jitter exponential backoff, `baseMs * factor^(attempt-1)` capped at `capMs`, randomized in
// `[0, delay]`. Kept local rather than importing the app's `@mistral/common/utils/backoff`: this is
// the published `@mistralai-capabilities/feature-speech` package, whose type-check runs against the public
// dependency graph and must not depend on an app-only template package.
function backoffDelay(attempt: number, baseMs: number, capMs: number, factor: number): number {
  if (attempt <= 0) return 0;
  const expo = Math.min(capMs, baseMs * Math.pow(factor, attempt - 1));
  return Math.random() * expo;
}

interface LogicalSession<TData> {
  data: TData;
  openPromise: PromiseWithResolvers<void>;
  closePromise: PromiseWithResolvers<TData>;
  opened: boolean;
  settled: boolean;
  closedByClient: boolean;
}

function createWebSocketSession<TSend, TReceive, TData>(
  config: WebSocketSessionConfig<TSend, TReceive, TData>,
) {
  const policy = config.reconnect;
  const baseMs = policy?.baseMs ?? 500;
  const capMs = policy?.capMs ?? 8_000;
  const factor = policy?.factor ?? 2;

  let state: WebSocketSessionState<TData> = { status: "idle" };
  let logical: LogicalSession<TData> | null = null;
  let ws: WebSocket | null = null;
  let factory: WebSocketFactory | null = null;
  const queue: string[] = [];
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Resolves when a reconnected session reports ready, so the handshake resends `session.update`
  // only after `session.created` — the same ordering the initial connect enforces.
  let readyWaiter: PromiseWithResolvers<void> | null = null;
  const listeners = new Set<() => void>();

  const notify = () => listeners.forEach((l) => l());
  const setState = (next: WebSocketSessionState<TData>) => {
    state = next;
    notify();
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const sendRaw = (payload: string) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
      return;
    }
    queue.push(payload);
  };

  const send = (message: TSend) => {
    if (!logical) return;
    sendRaw(JSON.stringify(message));
  };

  const finishWithData = (data: TData) => {
    if (!logical || logical.settled) return;
    logical.settled = true;
    const closePromise = logical.closePromise;
    clearReconnectTimer();
    if (readyWaiter) {
      readyWaiter.resolve();
      readyWaiter = null;
    }
    ws = null;
    logical = null;
    setState({ status: "closed", data });
    closePromise.resolve(data);
  };

  const finishWithError = (error: Error) => {
    if (!logical || logical.settled) return;
    logical.settled = true;
    const { opened, openPromise, closePromise, data } = logical;
    clearReconnectTimer();
    if (readyWaiter) {
      readyWaiter.resolve();
      readyWaiter = null;
    }
    ws = null;
    logical = null;
    setState({ status: "error", error, data });
    if (!opened) openPromise.reject(error);
    closePromise.reject(error);
  };

  const runRehandshake = async () => {
    if (!policy || !logical) return;
    // Wait for the fresh session to report ready before resending the handshake. A `session.created`
    // that arrives between socket-open and here flips `isReady` synchronously, so no message can
    // slip between the check and the waiter assignment below.
    if (!policy.isReady(logical.data)) {
      const waiter = promiseWithResolvers<void>();
      readyWaiter = waiter;
      await waiter.promise.catch(() => {});
    } else {
      reconnectAttempts = 0;
    }
    if (!logical || logical.settled) return;
    policy.rehandshake(send, logical.data);
  };

  const attach = (socket: WebSocket) => {
    socket.binaryType = "arraybuffer";

    socket.addEventListener("open", () => {
      if (ws !== socket || !logical) return;
      const firstOpen = !logical.opened;
      logical.opened = true;
      setState({ status: "open", data: logical.data });
      queue.forEach((payload) => socket.send(payload));
      queue.length = 0;
      if (firstOpen) {
        logical.openPromise.resolve();
      } else {
        void runRehandshake();
      }
    });

    socket.addEventListener("message", (event) => {
      if (ws !== socket || !logical) return;
      try {
        const text =
          typeof event.data === "string"
            ? event.data
            : new TextDecoder().decode(event.data as ArrayBuffer);
        const message = JSON.parse(text) as TReceive;
        const result = config.reducer(logical.data, message);
        logical.data = result.data;
        setState({ status: "open", data: result.data });
        if (readyWaiter && policy?.isReady(result.data)) {
          // A reconnected session stabilized: clear the retry budget and release the handshake.
          reconnectAttempts = 0;
          const waiter = readyWaiter;
          readyWaiter = null;
          waiter.resolve();
        }
        if (result.done) {
          logical.closedByClient = true;
          socket.close(1000);
          finishWithData(result.data);
        }
      } catch (err) {
        // A malformed frame or a protocol `error` frame (the reducer throws on it) is terminal:
        // reconnecting cannot fix a bad message, so surface it rather than retry.
        logical.closedByClient = true;
        socket.close(4000);
        finishWithError(err instanceof Error ? err : new Error(String(err)));
      }
    });

    socket.addEventListener("error", () => {});

    socket.addEventListener("close", (event) => {
      if (ws !== socket || !logical || logical.settled) return;
      if (logical.closedByClient || event.code === 1000) {
        finishWithData(logical.data);
        return;
      }
      const reason = event.reason ? ` - ${event.reason}` : "";
      scheduleReconnect(new Error(`WebSocket closed (${event.code})${reason}`));
    });
  };

  const connect = async () => {
    if (!logical || logical.settled || !factory) return;
    let socket: WebSocket;
    try {
      socket = await factory();
    } catch (err) {
      scheduleReconnect(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (!logical || logical.settled) {
      // Cancelled while minting the fresh token — discard the socket we just opened.
      try {
        socket.close(1001);
      } catch {
        // Already closing/closed; nothing to do.
      }
      return;
    }
    ws = socket;
    attach(socket);
  };

  function scheduleReconnect(cause: Error) {
    if (!logical || logical.settled) return;
    // Reconnect only recovers a session that had actually opened. A connection that never opened
    // (e.g. the initial token mint failed) fails fast so the UI surfaces it without a retry stall.
    if (!policy || logical.closedByClient || !logical.opened) {
      finishWithError(cause);
      return;
    }
    if (reconnectAttempts >= policy.maxAttempts) {
      finishWithError(
        new Error(
          `Realtime reconnect failed after ${policy.maxAttempts} attempt(s): ${cause.message}`,
        ),
      );
      return;
    }
    reconnectAttempts += 1;
    ws = null;
    // Hold the audio gate immediately so nothing streams before the fresh session's `session.update`.
    policy.onReconnecting();
    // Drop audio buffered during the outage: the fresh session transcribes only new audio, which is
    // exactly what keeps committed text from being duplicated.
    queue.length = 0;
    // Fold the dropped session's text into the committed baseline so the next session's atomic
    // `done` replace cannot wipe it.
    logical.data = policy.commit(logical.data);
    setState({ status: "reconnecting", data: logical.data, attempt: reconnectAttempts });
    const delay = backoffDelay(reconnectAttempts, baseMs, capMs, factor);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  }

  const open = (wsFactory: WebSocketFactory) => {
    if (logical) return;
    factory = wsFactory;
    reconnectAttempts = 0;
    clearReconnectTimer();
    logical = {
      data: config.initialData,
      openPromise: promiseWithResolvers<void>(),
      closePromise: promiseWithResolvers<TData>(),
      opened: false,
      settled: false,
      closedByClient: false,
    };
    queue.length = 0;
    setState({ status: "connecting" });
    void connect();
  };

  const cancel = () => {
    if (!logical || logical.settled) return;
    logical.closedByClient = true;
    clearReconnectTimer();
    const data = logical.data;
    const opened = logical.opened;
    const openPromise = logical.openPromise;
    try {
      ws?.close(4001);
    } catch {
      // Already closing/closed.
    }
    openPromise.promise.catch(() => {});
    logical.closePromise.promise.catch(() => {});
    // Cancellation is a clean client teardown, not a failure: settle as closed so it never surfaces
    // as a UI error. A pending waitForOpen still rejects so an in-flight start unblocks.
    if (!opened) openPromise.reject(new Error("WebSocket session was cancelled"));
    finishWithData(data);
  };

  const reset = () => {
    if (logical) cancel();
    clearReconnectTimer();
    factory = null;
    reconnectAttempts = 0;
    queue.length = 0;
    setState({ status: "idle" });
  };

  const waitForOpen = (): Promise<void> => {
    if (!logical) {
      if (state.status === "open") return Promise.resolve();
      if (state.status === "error") return Promise.reject(state.error);
      return Promise.reject(new Error("Session not started"));
    }
    if (logical.opened) return Promise.resolve();
    return logical.openPromise.promise;
  };

  const waitForClose = (): Promise<TData> => {
    if (!logical) {
      if (state.status === "closed") return Promise.resolve(state.data);
      if (state.status === "error") return Promise.reject(state.error);
      return Promise.reject(new Error("Session not open"));
    }
    return logical.closePromise.promise;
  };

  return {
    open,
    send,
    cancel,
    reset,
    waitForOpen,
    waitForClose,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => state,
  };
}

function getServerSnapshot<TData>(): WebSocketSessionState<TData> {
  return { status: "idle" } as WebSocketSessionState<TData>;
}

export function useWebSocketSession<TSend, TReceive, TData>(
  config: WebSocketSessionConfig<TSend, TReceive, TData>,
) {
  const [session] = useState(() => createWebSocketSession<TSend, TReceive, TData>(config));

  const getServerSnapshotStable = useCallback(() => getServerSnapshot<TData>(), []);

  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    getServerSnapshotStable,
  );

  useEffect(() => {
    return () => {
      session.cancel();
    };
  }, [session]);

  const open = useCallback(
    (wsFactory: WebSocketFactory) => {
      session.open(wsFactory);
    },
    [session],
  );

  return { ...session, open, state };
}
