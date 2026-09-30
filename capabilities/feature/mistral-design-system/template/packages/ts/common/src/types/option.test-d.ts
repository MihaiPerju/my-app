import { isSome, isNone, some, none } from "../utils/option";
import type { Equal, Expect } from "./assertions";
import type { Option, Some } from "./option";

// ============================================================================
// Option Tests
// ============================================================================

// Option should be Some<T> | null
type TestOption = Option<string>;
type _testOption = Expect<Equal<TestOption, Some<string> | null>>;

// Option with number
type TestOptionNumber = Option<number>;
type _testOptionNumber = Expect<Equal<TestOptionNumber, Some<number> | null>>;

// ============================================================================
// Some Tests
// ============================================================================

// Some should have a value property
type TestSome = Some<string>;
type _testSome = Expect<Equal<TestSome, { value: string }>>;

// Some with different types
type TestSomeNumber = Some<number>;
type _testSomeNumber = Expect<Equal<TestSomeNumber, { value: number }>>;

// ============================================================================
// Integration Tests
// ============================================================================

// Option should accept Some
type _testOptionAcceptsSome = Expect<
  Equal<Some<string> extends Option<string> ? true : false, true>
>;

// null should be assignable to Option
type _testOptionAcceptsNull = Expect<
  Equal<null extends Option<string> ? true : false, true>
>;

// Option should not accept other types
type _testOptionRejectsOther = Expect<
  Equal<{ other: string } extends Option<string> ? true : false, false>
>;

// ============================================================================
// isSome / isNone Guard Tests
// ============================================================================

declare const opt: Option<string>;

// isSome narrows to Some<T>
if (isSome(opt)) {
  type _testIsSomeNarrow = Expect<Equal<typeof opt, Some<string>>>;
}

// isNone narrows to null
if (isNone(opt)) {
  type _testIsNoneNarrow = Expect<Equal<typeof opt, null>>;
}

// isSome / isNone work on concrete values
const knownSome = some("hello");
type _testKnownSomeType = Expect<Equal<typeof knownSome, Some<string>>>;
// isSome(knownSome) is a boolean (not a type-level assertion — verify at runtime)

const knownNone = none<string>();
type _testKnownNoneType = Expect<Equal<typeof knownNone, Option<string>>>;
