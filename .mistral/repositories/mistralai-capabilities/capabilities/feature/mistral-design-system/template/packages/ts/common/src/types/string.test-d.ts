import type { Equal, Expect } from "./assertions";
import type { Stringifyable } from "./string";

// ============================================================================
// Stringifyable Tests
// ============================================================================

// Stringifyable should be a union of number, string, boolean, null, undefined, and objects with toString
type TestStringifyable = Stringifyable;
type _testStringifyable = Expect<
  Equal<
    TestStringifyable,
    number | string | boolean | null | undefined | { toString: () => string }
  >
>;

// number should be assignable to Stringifyable
type _testNumberAssignable = Expect<
  Equal<number extends Stringifyable ? true : false, true>
>;

// string should be assignable to Stringifyable
type _testStringAssignable = Expect<
  Equal<string extends Stringifyable ? true : false, true>
>;

// boolean should be assignable to Stringifyable
type _testBooleanAssignable = Expect<
  Equal<boolean extends Stringifyable ? true : false, true>
>;

// null should be assignable to Stringifyable
type _testNullAssignable = Expect<
  Equal<null extends Stringifyable ? true : false, true>
>;

// undefined should be assignable to Stringifyable
type _testUndefinedAssignable = Expect<
  Equal<undefined extends Stringifyable ? true : false, true>
>;

// Object with toString method should be assignable to Stringifyable
type TestObjectWithToString = { toString: () => string };
type _testObjectWithToStringAssignable = Expect<
  Equal<TestObjectWithToString extends Stringifyable ? true : false, true>
>;

// Object with toString that returns string should be assignable
type TestObjectWithStringToString = { toString: () => "hello" };
type _testObjectWithStringToStringAssignable = Expect<
  Equal<TestObjectWithStringToString extends Stringifyable ? true : false, true>
>;
