import type { Equal, Expect } from "./assertions";

// ============================================================================
// Expect Tests
// ============================================================================

type _testExpectTrue = Expect<true>;
type _testExpectEqual = Expect<Equal<string, string>>;

// ============================================================================
// Equal Tests
// ============================================================================

type _testEqualSame = Expect<Equal<string, string>>;
type _testEqualDifferent = Expect<Equal<Equal<string, number>, false>>;
type _testEqualObjects = Expect<
  Equal<Equal<{ a: string }, { a: string }>, true>
>;
type _testEqualDifferentObjects = Expect<
  Equal<Equal<{ a: string }, { b: string }>, false>
>;
type _testEqualArrays = Expect<Equal<Equal<string[], number[]>, false>>;
type _testEqualNullUndefined = Expect<Equal<Equal<null, undefined>, false>>;
