import { describe, expect, expectTypeOf, it } from "vitest";

import { omitUndefinedValues } from "./objects";

describe("omitUndefinedValues", () => {
  it("omits keys whose value is undefined", () => {
    const result = omitUndefinedValues({
      id: "user_123",
      name: "Ada Lovelace",
      nickname: undefined,
      score: 42,
    });

    expect(result).toEqual({
      id: "user_123",
      name: "Ada Lovelace",
      score: 42,
    });
  });

  it("keeps defined falsy values", () => {
    const result = omitUndefinedValues({
      emptyString: "",
      zero: 0,
      falseValue: false,
      nullValue: null,
      missing: undefined,
    });

    expect(result).toEqual({
      emptyString: "",
      zero: 0,
      falseValue: false,
      nullValue: null,
    });
  });

  it("returns an empty object when every value is undefined", () => {
    const result = omitUndefinedValues({
      first: undefined,
      second: undefined,
    });

    expect(result).toEqual({});
  });

  it("does not mutate the input object", () => {
    const input = {
      keep: "value",
      remove: undefined as string | undefined,
    };

    const result = omitUndefinedValues(input);

    expect(result).toEqual({ keep: "value" });
    expect(result).not.toBe(input);
    expect(input).toHaveProperty("remove");
    expect(input.remove).toBeUndefined();
  });

  it("is shallow and preserves references for nested defined values", () => {
    const nested = {
      internal: undefined,
      enabled: true,
    };
    const items = [1, 2, 3];

    const result = omitUndefinedValues({
      nested,
      items,
      missing: undefined,
    });

    expect(result).toEqual({
      nested,
      items,
    });
    expect(result.nested).toBe(nested);
    expect(result.items).toBe(items);
    expect("internal" in result.nested).toBe(true);
  });

  it("preserves the static shape honestly for maybe-undefined keys", () => {
    type Input = {
      required: string;
      maybeDefined: string | undefined;
      optional?: number;
      nullable: null | undefined;
      alwaysUndefined: undefined;
    };

    const input: Input = {
      required: "value",
      maybeDefined: "present",
      optional: 12,
      nullable: null,
      alwaysUndefined: undefined,
    };

    const result = omitUndefinedValues(input);

    expectTypeOf(result).toEqualTypeOf<{
      required: string;
      maybeDefined?: string;
      optional?: number;
      nullable?: null;
    }>();
  });

  it("distributes the static shape over union object types", () => {
    type Input =
      | {
          kind: "name";
          name: string | undefined;
          count: undefined;
        }
      | {
          kind: "score";
          score: number | undefined;
          count: undefined;
        };

    function omitUnion(value: Input) {
      return omitUndefinedValues(value);
    }

    const result = omitUnion({
      kind: "name",
      name: "Ada Lovelace",
      count: undefined,
    });

    expectTypeOf(result).toEqualTypeOf<
      | {
          kind: "name";
          name?: string;
        }
      | {
          kind: "score";
          score?: number;
        }
    >();
  });

  it("removes maybe-undefined keys at runtime when their current value is undefined", () => {
    type Input = {
      required: string;
      maybeDefined: string | undefined;
      optional?: number;
      nullable: null | undefined;
      alwaysUndefined: undefined;
    };

    const input: Input = {
      required: "value",
      maybeDefined: undefined,
      nullable: undefined,
      alwaysUndefined: undefined,
    };

    const result = omitUndefinedValues(input);

    expect(result).toEqual({
      required: "value",
    });
  });
});
