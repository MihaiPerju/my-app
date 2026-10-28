/**
 * A type representing a value that may or may not be a `Promise`.
 * Useful for callback functions that can return either `void` synchronously
 * or a `Promise` asynchronously.
 *
 * @template T - The type that the Promise resolves to. Defaults to `void`.
 *
 * @example
 * ```ts
 * type Callback = () => Awaitable;
 * type AsyncCallback<T> = (value: T) => Awaitable<string>;
 * ```
 */
export type Awaitable<T = void> = T | Promise<T>;
