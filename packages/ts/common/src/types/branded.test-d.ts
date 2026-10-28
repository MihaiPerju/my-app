import type { Equal, Expect } from "./assertions";
import type { Branded } from "./branded";
import { brand } from "./branded";

// ============================================================================
// Branded Tests
// ============================================================================

type UserId = Branded<string, "UserId">;
type OrderId = Branded<string, "OrderId">;
type Email = Branded<string, "Email">;

// Branded types should not be assignable to each other
// This test verifies they are different types
type _testBrandedDifferent = Expect<Equal<Equal<UserId, OrderId>, false>>;
type _testBrandedDifferent2 = Expect<Equal<Equal<UserId, Email>, false>>;

// Branded types should be assignable to their base type
type _testBrandedToBase = Expect<
  Equal<UserId extends string ? true : false, true>
>;

// Branded types should preserve the base type's properties
type TestBrandedNumber = Branded<number, "Count">;
type _testBrandedNumber = Expect<
  Equal<TestBrandedNumber extends number ? true : false, true>
>;

// ============================================================================
// brand() Constructor Tests
// ============================================================================

type UserIdBrand = Branded<string, "UserId">;

// brand() should return the correct Branded type
const brandedValue = brand<string, "UserId">("user-123");
type _testBrandReturn = Expect<Equal<typeof brandedValue, UserIdBrand>>;

// brand() result should be assignable to the base type
type _testBrandToBase = Expect<
  Equal<typeof brandedValue extends string ? true : false, true>
>;

// brand() result should not be assignable to a differently-branded type
type _testBrandNotAssignable = Expect<
  Equal<Equal<typeof brandedValue, Branded<string, "OrderId">>, false>
>;
