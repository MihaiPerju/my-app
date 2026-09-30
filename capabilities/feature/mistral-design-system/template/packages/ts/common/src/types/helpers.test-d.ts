import type { Equal, Expect } from "./assertions";
import type {
  DistributiveOmit,
  IntersectionOfObjectUnion,
  Prettify,
  Tuple,
  ValueOf,
  WithPartial,
} from "./helpers";

// ============================================================================
// ValueOf Tests
// ============================================================================

type TestObject = { a: string; b: number; c: boolean };
type TestValueOf = ValueOf<TestObject>;
type _testValueOf = Expect<Equal<TestValueOf, string | number | boolean>>;

// ============================================================================
// Prettify Tests
// ============================================================================

type TestPrettifyInput = { a: string } & { b: number };
type TestPrettify = Prettify<TestPrettifyInput>;
type _testPrettify = Expect<Equal<TestPrettify, { a: string; b: number }>>;

// ============================================================================
// WithPartial Tests
// ============================================================================

type TestWithPartialInput = { a: string; b: number; c: boolean };
type TestWithPartial = WithPartial<TestWithPartialInput, "a" | "b">;
type _testWithPartial = Expect<
  Equal<TestWithPartial, { a?: string; b?: number; c: boolean }>
>;

// ============================================================================
// DistributiveOmit Tests
// ============================================================================

type TestDistributiveOmitInput = { a: string; b: number; c: boolean };
type TestDistributiveOmit = DistributiveOmit<TestDistributiveOmitInput, "a">;
type _testDistributiveOmit = Expect<
  Equal<TestDistributiveOmit, { b: number; c: boolean }>
>;

type TestUnionA = { type: "a"; a: string; common: number };
type TestUnionB = { type: "b"; b: string; common: number };
type TestDistributiveOmitUnion = DistributiveOmit<
  TestUnionA | TestUnionB,
  "common"
>;
type _testDistributiveOmitUnion = Expect<
  Equal<
    TestDistributiveOmitUnion,
    { type: "a"; a: string } | { type: "b"; b: string }
  >
>;

// ============================================================================
// IntersectionOfObjectUnion Tests
// ============================================================================

type TestIntersectionA = { a: string; b: number };
type TestIntersectionB = { a: string; c: boolean };
type TestIntersectionC = { a: string; d: symbol };
type TestIntersection = IntersectionOfObjectUnion<
  TestIntersectionA | TestIntersectionB | TestIntersectionC
>;
type _testIntersection = Expect<Equal<TestIntersection, { a: string }>>;

// ============================================================================
// Tuple Tests
// ============================================================================

type TestTuple = Tuple<string>;
type _testTuple = Expect<Equal<TestTuple, [] | [string, ...string[]]>>;
