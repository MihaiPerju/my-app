import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  apply,
  createPatchSchema,
  diff,
  type Draft,
  type Patch,
  produce,
} from "./patch";

describe("patch", () => {
  describe("createPatchSchema", () => {
    const schema = createPatchSchema(
      z.object({ message: z.string(), count: z.number() }),
    );

    it("validates complete root replacements", () => {
      expect(
        schema.safeParse({
          op: "replace",
          path: "",
          value: { message: "hello", count: 1 },
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          op: "replace",
          path: "/",
          value: { message: "hello" },
        }).success,
      ).toBe(false);
      expect(
        schema.parse({
          op: "replace",
          path: "/",
          value: { message: "hello", count: 1, ignored: true },
        }),
      ).toEqual({
        op: "replace",
        path: "/",
        value: { message: "hello", count: 1 },
      });
    });

    it("keeps non-root values unknown and append values textual", () => {
      expect(
        schema.parse({
          op: "add",
          path: "/nested/value",
          value: { anything: true },
        }),
      ).toEqual({
        op: "add",
        path: "/nested/value",
        value: { anything: true },
      });
      expect(
        schema.safeParse({ op: "append", path: "/message", value: 1 }).success,
      ).toBe(false);
      expect(schema.parse({ op: "remove", path: "/nested/value" })).toEqual({
        op: "remove",
        path: "/nested/value",
      });
    });
  });

  describe("produce", () => {
    it("should create patches for simple object mutations", () => {
      const initialState = { name: "John", age: 30 };

      const [newState, patches] = produce(initialState, (draft) => {
        draft.name = "Jane";
        draft.age = 25;
      });

      expect(newState).toEqual({ name: "Jane", age: 25 });
      expect(patches).toEqual([
        { op: "replace", path: "/name", value: "Jane" },
        { op: "replace", path: "/age", value: 25 },
      ]);
    });

    it("should create append patches for string concatenation", () => {
      const initialState = { message: "Hello" };

      const [newState, patches] = produce(initialState, (draft) => {
        draft.message = "Hello World";
      });

      expect(newState).toEqual({ message: "Hello World" });
      expect(patches).toEqual([
        { op: "append", path: "/message", value: " World" },
      ]);
    });

    it("should handle nested object mutations", () => {
      const initialState = {
        user: { name: "John", profile: { age: 30 } },
      };

      const [newState, patches] = produce(initialState, (draft) => {
        draft.user.name = "Jane";
        draft.user.profile.age = 25;
      });

      expect(newState).toEqual({
        user: { name: "Jane", profile: { age: 25 } },
      });
      expect(patches).toEqual([
        { op: "replace", path: "/user/profile/age", value: 25 },
        { op: "replace", path: "/user/name", value: "Jane" },
      ]);
    });

    it("should handle array mutations", () => {
      const initialState = { items: ["a", "b"] };

      const [newState, patches] = produce(initialState, (draft) => {
        draft.items.push("c");
        draft.items[0] = "x";
      });

      expect(newState).toEqual({ items: ["x", "b", "c"] });
      expect(patches).toEqual([
        { op: "replace", path: "/items/0", value: "x" },
        { op: "add", path: "/items/2", value: "c" },
      ]);
    });

    it("should not create append patches for non-string values", () => {
      const initialState = { count: 5 };

      const [newState, patches] = produce(initialState, (draft) => {
        draft.count = 10;
      });

      expect(newState).toEqual({ count: 10 });
      expect(patches).toEqual([{ op: "replace", path: "/count", value: 10 }]);
    });

    it("should not create append patches when new value doesn't start with old value", () => {
      const initialState = { message: "Hello" };

      const [newState, patches] = produce(initialState, (draft) => {
        draft.message = "Goodbye";
      });

      expect(newState).toEqual({ message: "Goodbye" });
      expect(patches).toEqual([
        { op: "replace", path: "/message", value: "Goodbye" },
      ]);
    });

    it("should handle empty string to string conversion", () => {
      const initialState = { message: "" };

      const [newState, patches] = produce(initialState, (draft) => {
        draft.message = "Hello";
      });

      expect(newState).toEqual({ message: "Hello" });
      expect(patches).toEqual([
        { op: "append", path: "/message", value: "Hello" },
      ]);
    });

    it("should handle undefined to string conversion", () => {
      const initialState: { message: string | undefined } = {
        message: undefined,
      };

      const [newState, patches] = produce(initialState, (draft) => {
        draft.message = "Hello";
      });

      expect(newState).toEqual({ message: "Hello" });
      expect(patches).toEqual([
        { op: "replace", path: "/message", value: "Hello" },
      ]);
    });
  });

  describe("apply", () => {
    it("should apply regular patches", () => {
      const initialState = { name: "John", age: 30 };
      const patches: Patch[] = [
        { op: "replace", path: "/name", value: "Jane" },
        { op: "replace", path: "/age", value: 25 },
      ];

      const result = apply(initialState, patches);

      expect(result).toEqual({ name: "Jane", age: 25 });
    });

    it("should apply append patches", () => {
      const initialState = { message: "Hello" };
      const patches: Patch[] = [
        { op: "append", path: "/message", value: " World" },
      ];

      const result = apply(initialState, patches);

      expect(result).toEqual({ message: "Hello World" });
    });

    it("should handle mixed patch types", () => {
      const initialState = { name: "John", message: "Hello" };
      const patches: Patch[] = [
        { op: "replace", path: "/name", value: "Jane" },
        { op: "append", path: "/message", value: " World" },
      ];

      const result = apply(initialState, patches);

      expect(result).toEqual({ name: "Jane", message: "Hello World" });
    });

    it("should handle nested path patches", () => {
      const initialState = {
        user: { name: "John", profile: { age: 30 } },
      };
      const patches: Patch[] = [
        { op: "replace", path: "/user/name", value: "Jane" },
        { op: "replace", path: "/user/profile/age", value: 25 },
      ];

      const result = apply(initialState, patches);

      expect(result).toEqual({
        user: { name: "Jane", profile: { age: 25 } },
      });
    });

    it("should handle array patches", () => {
      const initialState = { items: ["a", "b"] };
      const patches: Patch[] = [
        { op: "replace", path: "/items/0", value: "x" },
        { op: "add", path: "/items/2", value: "c" },
      ];

      const result = apply(initialState, patches);

      expect(result).toEqual({ items: ["x", "b", "c"] });
    });

    it("should handle append patches with non-existent paths", () => {
      const initialState = { message: "Hello" };
      const patches: Patch[] = [
        { op: "append", path: "/nonexistent", value: " World" },
      ];

      const result = apply(initialState, patches);

      expect(result).toEqual({ message: "Hello" });
    });

    it("should handle append patches with non-string values at path", () => {
      const initialState = { count: 5 };
      const patches: Patch[] = [
        { op: "append", path: "/count", value: " World" },
      ];

      const result = apply(initialState, patches);

      expect(result).toEqual({ count: 5 });
    });

    it("should apply add patches", () => {
      const initialState = { identifier: "weather-poem" };
      const patches: Patch[] = [{ op: "add", path: "/type", value: "text" }];

      const result = apply(initialState, patches);
      expect(result).toEqual({ identifier: "weather-poem", type: "text" });
    });
  });

  describe("type exports", () => {
    it("should export Patch type", () => {
      const patch: Patch = { op: "replace", path: "/test", value: "value" };
      expect(patch.op).toBe("replace");
    });

    it("should export Draft type", () => {
      const draft: Draft<{ name: string }> = { name: "test" };
      expect(draft.name).toBe("test");
    });

    it("should allow append patch type", () => {
      const appendPatch: Patch = {
        op: "append",
        path: "/message",
        value: " World",
      };
      expect(appendPatch.op).toBe("append");
    });
  });

  describe("edge cases", () => {
    it("should handle empty patches array", () => {
      const initialState = { name: "John" };
      const patches: Patch[] = [];

      const result = apply(initialState, patches);

      expect(result).toEqual(initialState);
    });

    it("should handle complex nested structures", () => {
      const initialState = {
        users: [
          { name: "John", messages: ["Hello"] },
          { name: "Jane", messages: ["Hi"] },
        ],
      };

      const [newState, patches] = produce(initialState, (draft) => {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        draft.users[0]!.messages[0] = "Hello World";
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        draft.users[1]!.name = "Pierre";
      });

      expect(newState).toEqual({
        users: [
          { name: "John", messages: ["Hello World"] },
          { name: "Pierre", messages: ["Hi"] },
        ],
      });

      expect(patches).toEqual([
        { op: "replace", path: "/users/1/name", value: "Pierre" },
        { op: "append", path: "/users/0/messages/0", value: " World" },
      ]);
    });

    it("should handle multiple append operations on same path", () => {
      const initialState = { message: "Hello" };

      let currentState = initialState;
      let allPatches: Patch[] = [];

      // First append
      const [state1, patches1] = produce(currentState, (draft) => {
        draft.message = "Hello World";
      });
      currentState = state1;
      allPatches = [...allPatches, ...patches1];

      // Second append
      const [state2, patches2] = produce(currentState, (draft) => {
        draft.message = "Hello World!";
      });
      currentState = state2;
      allPatches = [...allPatches, ...patches2];

      expect(currentState).toEqual({ message: "Hello World!" });
      expect(allPatches).toEqual([
        { op: "append", path: "/message", value: " World" },
        { op: "append", path: "/message", value: "!" },
      ]);

      // Apply all patches to original state
      const finalState = apply(initialState, allPatches);
      expect(finalState).toEqual({ message: "Hello World!" });
    });

    it("should support replacing the whole state", () => {
      const initialState = { name: "John" };
      const newState = { name: "Gabriel", age: 123 };
      const [updatedState, patches] = produce(initialState, () => {
        return newState;
      });
      expect(updatedState).toEqual(newState);
      expect(patches).toEqual([
        { op: "replace", path: "/", value: { name: "Gabriel", age: 123 } },
      ]);
    });
  });

  describe("type checking", () => {
    it("it's forbidden to apply a patch if types do not match", () => {
      type A = { name: string };
      type B = { age: number };
      const patches: Patch<A>[] = [
        { op: "replace", path: "/name", value: "John" },
      ];
      const a: A = { name: "John" };
      apply(a, patches); // ✅ type checks

      const b: B = { age: 30 };
      // @ts-expect-error - ❌ type error
      apply(b, patches);
    });
  });

  describe("diff", () => {
    it("should create patches for simple object mutations", () => {
      const initialState = { name: "John", age: 30 };
      const newState = { name: "Jane", age: 25 };
      const patches = diff(initialState, newState);
      expect(patches).toEqual([
        { op: "replace", path: "/age", value: 25 },
        { op: "replace", path: "/name", value: "Jane" },
      ]);
    });
    it("should create append patches when appending text", () => {
      const initialState = { content: "Hello" };
      const newState = { content: "Hello World" };
      const patches = diff(initialState, newState);
      expect(patches).toEqual([
        { op: "append", path: "/content", value: " World" },
      ]);
    });

    it("should return a replace patch if the state is undefined", () => {
      const initialState = undefined;
      const newState = { content: "Hello World" };
      const patches = diff(initialState, newState);
      expect(patches).toEqual([
        { op: "replace", path: "/", value: { content: "Hello World" } },
      ]);
    });
  });
});
