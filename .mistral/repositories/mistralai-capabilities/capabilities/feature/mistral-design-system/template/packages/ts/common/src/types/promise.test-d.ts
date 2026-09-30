import type { Equal, Expect } from "./assertions";
import type { Awaitable } from "./promise";

// ============================================================================
// Awaitable Tests
// ============================================================================

// Default to void - test that Awaitable resolves to void | Promise<void>
type TestAwaitableDefault = Awaitable;
type _testAwaitableDefault = Expect<
  Equal<TestAwaitableDefault, void | Promise<void>>
>;

// With specific type - test that Awaitable<string> resolves to string | Promise<string>
type TestAwaitableString = Awaitable<string>;
type _testAwaitableString = Expect<
  Equal<TestAwaitableString, string | Promise<string>>
>;

// With number - test that Awaitable<number> resolves to number | Promise<number>
type TestAwaitableNumber = Awaitable<number>;
type _testAwaitableNumber = Expect<
  Equal<TestAwaitableNumber, number | Promise<number>>
>;
