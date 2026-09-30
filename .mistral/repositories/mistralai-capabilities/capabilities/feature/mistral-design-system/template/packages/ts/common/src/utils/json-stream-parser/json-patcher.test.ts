import { describe, expect, it } from "vitest";

import { apply, type Patch } from "@mistral/common/utils/patch";

import { JSONPatcher } from "./json-patcher";
import type { ServerStreamChunk } from "./test-helpers";
import { complexJsonExamples, createLlmJsonStream } from "./test-helpers";

describe("JSONPatcher", () => {
  it("emits patches for streamed object values", () => {
    const patcher = new JSONPatcher();

    expect(patcher.write('{"name":"A')).toEqual([
      { op: "replace", path: "/", value: {} },
      { op: "add", path: "/name", value: "A" },
    ]);

    expect(patcher.write('lice","age":3}')).toEqual([
      { op: "append", path: "/name", value: "lice" },
      { op: "add", path: "/age", value: 3 },
    ]);

    expect(patcher.end()).toEqual([]);
  });

  it("emits patches for arrays and nested objects", () => {
    const patcher = new JSONPatcher();

    const patches = patcher.write('[1,{"a":true}]');

    expect(patches).toEqual([
      { op: "replace", path: "/", value: [] },
      { op: "add", path: "/0", value: 1 },
      { op: "add", path: "/1", value: {} },
      { op: "add", path: "/1/a", value: true },
    ]);

    expect(patcher.end()).toEqual([]);
  });

  it("reconstructs JSON by applying streamed patches", () => {
    const patcher = new JSONPatcher();
    let currentValue: unknown = null;

    const applyPatches = (patches: Patch[]) => {
      if (!patches.length) return;

      if (patches[0]?.op === "replace" && patches[0].path === "/") {
        currentValue = patches[0].value;
        if (patches.length > 1) {
          currentValue = apply(currentValue, patches.slice(1));
        }
        return;
      }

      if (currentValue !== null) {
        currentValue = apply(currentValue, patches);
      }
    };

    applyPatches(patcher.write('{"items":['));
    applyPatches(patcher.write('{"id":1},"t'));
    applyPatches(patcher.write('wo"]}'));
    applyPatches(patcher.end());

    expect(currentValue).toEqual({ items: [{ id: 1 }, "two"] });
  });

  const serverStreamDirectPatcher = function* (
    jsonChunkStream: Generator<string>,
  ): Generator<ServerStreamChunk> {
    const parser = new JSONPatcher();

    let hasSentFirstPatch = false;
    for (const chunk of jsonChunkStream) {
      const patch: Patch[] = parser.write(chunk);

      if (!patch.length) {
        continue;
      }

      if (!hasSentFirstPatch) {
        const [firstPatch, ...rest] = patch;
        yield {
          type: "initialization",
          value: firstPatch?.op === "replace" ? firstPatch.value : {},
        };
        if (rest.length) {
          yield { type: "update", patch: rest };
        }
        hasSentFirstPatch = true;
        continue;
      }

      if (patch.length) {
        yield { type: "update", patch };
      }
    }
    const patch = parser.end();
    if (patch.length) {
      yield { type: "update", patch };
    }
  };

  it.each(complexJsonExamples)(
    "Direct translation into patches – $description",
    ({ input }) => {
      const llmJsonStream = createLlmJsonStream(input);

      let wipValue: unknown = null;
      for (const chunk of serverStreamDirectPatcher(llmJsonStream)) {
        switch (chunk.type) {
          case "initialization":
            wipValue = chunk.value;
            break;
          case "update":
            if (
              chunk.patch[0]?.op === "replace" &&
              chunk.patch[0].path === "/"
            ) {
              wipValue = chunk.patch[0].value;
            } else {
              wipValue = apply(wipValue, chunk.patch);
            }
            break;
          case "complete":
            wipValue = chunk.value;
            break;
        }
      }
      expect(wipValue).toEqual(JSON.parse(input));
    },
  );

  describe("edge cases", () => {
    it("handles empty object", () => {
      const patcher = new JSONPatcher();
      expect(patcher.write("{}")).toEqual([
        { op: "replace", path: "/", value: {} },
      ]);
      expect(patcher.end()).toEqual([]);
      expect(patcher.getPendingPathCount()).toBe(0);
    });

    it("handles empty array", () => {
      const patcher = new JSONPatcher();
      expect(patcher.write("[]")).toEqual([
        { op: "replace", path: "/", value: [] },
      ]);
      expect(patcher.end()).toEqual([]);
      expect(patcher.getPendingPathCount()).toBe(0);
    });

    it("handles deeply nested objects", () => {
      const patcher = new JSONPatcher();
      const json = '{"a":{"b":{"c":{"d":1}}}}';
      const patches = patcher.write(json);
      const finalPatches = patcher.end();
      expect([...patches, ...finalPatches]).toEqual([
        { op: "replace", path: "/", value: {} },
        { op: "add", path: "/a", value: {} },
        { op: "add", path: "/a/b", value: {} },
        { op: "add", path: "/a/b/c", value: {} },
        { op: "add", path: "/a/b/c/d", value: 1 },
      ]);
      expect(patcher.getPendingPathCount()).toBe(0);
    });

    it("handles deeply nested arrays", () => {
      const patcher = new JSONPatcher();
      const json = "[[[[[1]]]]]";
      const patches = patcher.write(json);
      const finalPatches = patcher.end();
      expect([...patches, ...finalPatches]).toEqual([
        { op: "replace", path: "/", value: [] },
        { op: "add", path: "/0", value: [] },
        { op: "add", path: "/0/0", value: [] },
        { op: "add", path: "/0/0/0", value: [] },
        { op: "add", path: "/0/0/0/0", value: [] },
        { op: "add", path: "/0/0/0/0/0", value: 1 },
      ]);
      expect(patcher.getPendingPathCount()).toBe(0);
    });

    it("handles mixed nested structures", () => {
      const patcher = new JSONPatcher();
      const json = '{"arr":[{"nested":[1,2,{"deep":true}]}]}';
      const patches = patcher.write(json);
      const finalPatches = patcher.end();
      expect([...patches, ...finalPatches]).toEqual([
        { op: "replace", path: "/", value: {} },
        { op: "add", path: "/arr", value: [] },
        { op: "add", path: "/arr/0", value: {} },
        { op: "add", path: "/arr/0/nested", value: [] },
        { op: "add", path: "/arr/0/nested/0", value: 1 },
        { op: "add", path: "/arr/0/nested/1", value: 2 },
        { op: "add", path: "/arr/0/nested/2", value: {} },
        { op: "add", path: "/arr/0/nested/2/deep", value: true },
      ]);
      expect(patcher.getPendingPathCount()).toBe(0);
    });

    it("handles multiple primitive values in object without duplicates", () => {
      const patcher = new JSONPatcher();
      const patches = patcher.write('{"a":1,"b":2,"c":3}');

      expect(patches).toEqual([
        { op: "replace", path: "/", value: {} },
        { op: "add", path: "/a", value: 1 },
        { op: "add", path: "/b", value: 2 },
        { op: "add", path: "/c", value: 3 },
      ]);
      expect(patcher.end()).toEqual([]);
      expect(patcher.getPendingPathCount()).toBe(0);
    });

    it("handles multiple primitive values in array without duplicates", () => {
      const patcher = new JSONPatcher();
      const patches = patcher.write("[1,2,3,4,5]");

      expect(patches).toEqual([
        { op: "replace", path: "/", value: [] },
        { op: "add", path: "/0", value: 1 },
        { op: "add", path: "/1", value: 2 },
        { op: "add", path: "/2", value: 3 },
        { op: "add", path: "/3", value: 4 },
        { op: "add", path: "/4", value: 5 },
      ]);
      expect(patcher.end()).toEqual([]);
      expect(patcher.getPendingPathCount()).toBe(0);
    });

    it("handles boolean values without duplicates", () => {
      const patcher = new JSONPatcher();
      const patches = patcher.write('{"t":true,"f":false}');

      expect(patches).toEqual([
        { op: "replace", path: "/", value: {} },
        { op: "add", path: "/t", value: true },
        { op: "add", path: "/f", value: false },
      ]);
      expect(patcher.getPendingPathCount()).toBe(0);
    });

    it("handles null values without duplicates", () => {
      const patcher = new JSONPatcher();
      const patches = patcher.write('{"n":null}');

      expect(patches).toEqual([
        { op: "replace", path: "/", value: {} },
        { op: "add", path: "/n", value: null },
      ]);
      expect(patcher.getPendingPathCount()).toBe(0);
    });

    it("handles streamed string that changes value", () => {
      const patcher = new JSONPatcher();

      expect(patcher.write('{"msg":"Hel')).toEqual([
        { op: "replace", path: "/", value: {} },
        { op: "add", path: "/msg", value: "Hel" },
      ]);

      expect(patcher.write("lo")).toEqual([
        { op: "append", path: "/msg", value: "lo" },
      ]);

      expect(patcher.write(' World!"}')).toEqual([
        { op: "append", path: "/msg", value: " World!" },
      ]);

      expect(patcher.end()).toEqual([]);
      expect(patcher.getPendingPathCount()).toBe(0);
    });

    it("handles streamed number that changes value", () => {
      const patcher = new JSONPatcher();

      // Numbers aren't emitted until a delimiter confirms completion
      expect(patcher.write('{"num":12')).toEqual([
        { op: "replace", path: "/", value: {} },
      ]);

      // Still accumulating the number
      expect(patcher.write("34")).toEqual([]);

      // Closing brace confirms the number is complete
      expect(patcher.write("}")).toEqual([
        { op: "add", path: "/num", value: 1234 },
      ]);

      expect(patcher.end()).toEqual([]);
      expect(patcher.getPendingPathCount()).toBe(0);
    });

    it("does not emit duplicate patches for unchanged values", () => {
      const patcher = new JSONPatcher();

      // First write starts the string
      patcher.write('{"s":"test"');

      // This chunk has no new content for the string
      const patches = patcher.write("}");

      // Should not have a replace for /s since value didn't change
      expect(patches).toEqual([]);
      expect(patcher.getPendingPathCount()).toBe(0);
    });

    it("handles objects with many keys for memory leak test", () => {
      const patcher = new JSONPatcher();
      const obj: Record<string, number> = {};
      for (let i = 0; i < 100; i++) {
        obj[`key${i}`] = i;
      }
      const json = JSON.stringify(obj);

      patcher.write(json);
      patcher.end();

      expect(patcher.getPendingPathCount()).toBe(0);
    });

    it("handles arrays with many elements for memory leak test", () => {
      const patcher = new JSONPatcher();
      const arr = Array.from({ length: 100 }, (_, i) => i);
      const json = JSON.stringify(arr);

      patcher.write(json);
      patcher.end();

      expect(patcher.getPendingPathCount()).toBe(0);
    });

    it("cleans up after parsing complex nested structure", () => {
      const patcher = new JSONPatcher();
      const complex = {
        users: [
          { id: 1, name: "Alice", tags: ["admin", "user"] },
          { id: 2, name: "Bob", tags: ["user"] },
        ],
        meta: {
          total: 2,
          nested: { deep: { value: true } },
        },
      };
      const json = JSON.stringify(complex);

      patcher.write(json);
      patcher.end();

      expect(patcher.getPendingPathCount()).toBe(0);
    });

    it("handles chunked parsing with pending paths cleaned up", () => {
      const patcher = new JSONPatcher();

      // Parse in very small chunks
      patcher.write("{");
      expect(patcher.getPendingPathCount()).toBe(0);

      patcher.write('"a"');
      expect(patcher.getPendingPathCount()).toBe(0);

      patcher.write(":");
      expect(patcher.getPendingPathCount()).toBe(0);

      patcher.write('"hel');
      expect(patcher.getPendingPathCount()).toBe(1); // String in progress

      patcher.write("lo");
      expect(patcher.getPendingPathCount()).toBe(1); // Still in progress

      // Closing quote + closing brace completes the string
      patcher.write('"}');
      expect(patcher.getPendingPathCount()).toBe(0); // String completed

      patcher.end();
      expect(patcher.getPendingPathCount()).toBe(0);
    });

    it("handles special characters in strings", () => {
      const patcher = new JSONPatcher();
      const json = '{"escaped":"line1\\nline2\\ttab\\"quote"}';

      patcher.write(json);
      patcher.end();

      expect(patcher.getPendingPathCount()).toBe(0);
    });

    it("handles unicode in strings", () => {
      const patcher = new JSONPatcher();
      const json = '{"emoji":"Hello 👋 World 🌍","chinese":"你好"}';

      patcher.write(json);
      patcher.end();

      expect(patcher.getPendingPathCount()).toBe(0);
    });

    it("handles negative and decimal numbers", () => {
      const patcher = new JSONPatcher();
      const patches = patcher.write('{"neg":-42,"dec":3.14,"exp":1e10}');

      expect(patches).toContainEqual({ op: "add", path: "/neg", value: -42 });
      expect(patches).toContainEqual({ op: "add", path: "/dec", value: 3.14 });
      expect(patches).toContainEqual({ op: "add", path: "/exp", value: 1e10 });

      patcher.end();
      expect(patcher.getPendingPathCount()).toBe(0);
    });

    it("handles primitive values at root level", () => {
      const patcher1 = new JSONPatcher();
      patcher1.write('"just a string"');
      patcher1.end();
      expect(patcher1.getPendingPathCount()).toBe(0);

      const patcher2 = new JSONPatcher();
      patcher2.write("42");
      patcher2.end();
      expect(patcher2.getPendingPathCount()).toBe(0);

      const patcher3 = new JSONPatcher();
      patcher3.write("true");
      patcher3.end();
      expect(patcher3.getPendingPathCount()).toBe(0);

      const patcher4 = new JSONPatcher();
      patcher4.write("null");
      patcher4.end();
      expect(patcher4.getPendingPathCount()).toBe(0);
    });

    it("handles reusing paths in different array indices", () => {
      const patcher = new JSONPatcher();
      // Two objects with the same key structure
      const json = '[{"id":1},{"id":2}]';

      const patches = patcher.write(json);

      // Should have separate adds for each /0/id and /1/id
      expect(patches).toContainEqual({ op: "add", path: "/0/id", value: 1 });
      expect(patches).toContainEqual({ op: "add", path: "/1/id", value: 2 });

      patcher.end();
      expect(patcher.getPendingPathCount()).toBe(0);
    });
  });

  describe("string append operations", () => {
    it("emits add for initial string value, then append for updates", () => {
      const patcher = new JSONPatcher();

      // Initial chunk with partial string
      expect(patcher.write('{"text":"Hello')).toEqual([
        { op: "replace", path: "/", value: {} },
        { op: "add", path: "/text", value: "Hello" },
      ]);

      // Subsequent chunks should use append, not replace
      expect(patcher.write(" ")).toEqual([
        { op: "append", path: "/text", value: " " },
      ]);

      expect(patcher.write("World")).toEqual([
        { op: "append", path: "/text", value: "World" },
      ]);

      expect(patcher.write('!"}')).toEqual([
        { op: "append", path: "/text", value: "!" },
      ]);

      expect(patcher.end()).toEqual([]);
    });

    it("handles empty string without emitting append", () => {
      const patcher = new JSONPatcher();

      expect(patcher.write('{"empty":""}')).toEqual([
        { op: "replace", path: "/", value: {} },
        { op: "add", path: "/empty", value: "" },
      ]);

      expect(patcher.end()).toEqual([]);
    });

    it("handles string that starts empty and grows", () => {
      const patcher = new JSONPatcher();

      // Start with opening quote only - no value event yet
      expect(patcher.write('{"growing":"')).toEqual([
        { op: "replace", path: "/", value: {} },
      ]);

      // Add content - emits add since this is the first value
      expect(patcher.write("content")).toEqual([
        { op: "add", path: "/growing", value: "content" },
      ]);

      expect(patcher.write('"}')).toEqual([]);
      expect(patcher.end()).toEqual([]);
    });

    it("handles string at root level being streamed", () => {
      const patcher = new JSONPatcher();

      expect(patcher.write('"start')).toEqual([
        { op: "replace", path: "/", value: "start" },
      ]);

      // Root level strings should also use append
      expect(patcher.write(" middle")).toEqual([
        { op: "append", path: "/", value: " middle" },
      ]);

      expect(patcher.write(' end"')).toEqual([
        { op: "append", path: "/", value: " end" },
      ]);

      expect(patcher.end()).toEqual([]);
    });

    it("handles multiple strings in the same object being streamed", () => {
      const patcher = new JSONPatcher();

      // First string partial
      expect(patcher.write('{"a":"first')).toEqual([
        { op: "replace", path: "/", value: {} },
        { op: "add", path: "/a", value: "first" },
      ]);

      // Complete first, start second
      expect(patcher.write('","b":"sec')).toEqual([
        { op: "add", path: "/b", value: "sec" },
      ]);

      // Continue second string
      expect(patcher.write("ond")).toEqual([
        { op: "append", path: "/b", value: "ond" },
      ]);

      expect(patcher.write('"}')).toEqual([]);
      expect(patcher.end()).toEqual([]);
    });

    it("handles strings in nested objects being streamed", () => {
      const patcher = new JSONPatcher();

      expect(patcher.write('{"outer":{"inner":"deep')).toEqual([
        { op: "replace", path: "/", value: {} },
        { op: "add", path: "/outer", value: {} },
        { op: "add", path: "/outer/inner", value: "deep" },
      ]);

      expect(patcher.write(" value")).toEqual([
        { op: "append", path: "/outer/inner", value: " value" },
      ]);

      expect(patcher.write('"}}')).toEqual([]);
      expect(patcher.end()).toEqual([]);
    });

    it("handles strings in arrays being streamed", () => {
      const patcher = new JSONPatcher();

      expect(patcher.write('["first')).toEqual([
        { op: "replace", path: "/", value: [] },
        { op: "add", path: "/0", value: "first" },
      ]);

      expect(patcher.write(" item")).toEqual([
        { op: "append", path: "/0", value: " item" },
      ]);

      expect(patcher.write('","second')).toEqual([
        { op: "add", path: "/1", value: "second" },
      ]);

      expect(patcher.write(' item"]')).toEqual([
        { op: "append", path: "/1", value: " item" },
      ]);

      expect(patcher.end()).toEqual([]);
    });

    it("handles string with unicode characters being streamed", () => {
      const patcher = new JSONPatcher();

      expect(patcher.write('{"emoji":"Hello ')).toEqual([
        { op: "replace", path: "/", value: {} },
        { op: "add", path: "/emoji", value: "Hello " },
      ]);

      expect(patcher.write("👋")).toEqual([
        { op: "append", path: "/emoji", value: "👋" },
      ]);

      expect(patcher.write(" World")).toEqual([
        { op: "append", path: "/emoji", value: " World" },
      ]);

      expect(patcher.write(' 🌍"}')).toEqual([
        { op: "append", path: "/emoji", value: " 🌍" },
      ]);

      expect(patcher.end()).toEqual([]);
    });

    it("handles string with escape sequences being streamed", () => {
      const patcher = new JSONPatcher();

      expect(patcher.write('{"escaped":"line1')).toEqual([
        { op: "replace", path: "/", value: {} },
        { op: "add", path: "/escaped", value: "line1" },
      ]);

      // Escape sequence for newline
      expect(patcher.write("\\n")).toEqual([
        { op: "append", path: "/escaped", value: "\n" },
      ]);

      expect(patcher.write("line2")).toEqual([
        { op: "append", path: "/escaped", value: "line2" },
      ]);

      expect(patcher.write('\\ttab"}')).toEqual([
        { op: "append", path: "/escaped", value: "\ttab" },
      ]);

      expect(patcher.end()).toEqual([]);
    });

    it("handles very long strings being streamed in many chunks", () => {
      const patcher = new JSONPatcher();

      // Opening quote only - no value event yet
      expect(patcher.write('{"long":"')).toEqual([
        { op: "replace", path: "/", value: {} },
      ]);

      // First chunk - emits add
      expect(patcher.write("chunk0")).toEqual([
        { op: "add", path: "/long", value: "chunk0" },
      ]);

      // Subsequent chunks - emit append
      for (let i = 1; i < 10; i++) {
        const chunk = `chunk${i}`;
        expect(patcher.write(chunk)).toEqual([
          { op: "append", path: "/long", value: chunk },
        ]);
      }

      expect(patcher.write('"}')).toEqual([]);
      expect(patcher.end()).toEqual([]);
      expect(patcher.getPendingPathCount()).toBe(0);
    });

    it("handles single character string updates", () => {
      const patcher = new JSONPatcher();

      // Opening quote only - no value event yet
      expect(patcher.write('{"char":"')).toEqual([
        { op: "replace", path: "/", value: {} },
      ]);

      // First character - emits add
      expect(patcher.write("a")).toEqual([
        { op: "add", path: "/char", value: "a" },
      ]);

      // Subsequent characters - emit append
      expect(patcher.write("b")).toEqual([
        { op: "append", path: "/char", value: "b" },
      ]);

      expect(patcher.write("c")).toEqual([
        { op: "append", path: "/char", value: "c" },
      ]);

      expect(patcher.write('"}')).toEqual([]);
      expect(patcher.end()).toEqual([]);
    });

    it("does not emit append when string value unchanged between writes", () => {
      const patcher = new JSONPatcher();

      expect(patcher.write('{"msg":"Hello')).toEqual([
        { op: "replace", path: "/", value: {} },
        { op: "add", path: "/msg", value: "Hello" },
      ]);

      // Write just the closing quote - no content change
      expect(patcher.write('"')).toEqual([]);

      // Write the rest
      expect(patcher.write("}")).toEqual([]);

      expect(patcher.end()).toEqual([]);
    });

    it("never emits replace for string updates, only append", () => {
      const patcher = new JSONPatcher();
      const allPatches: Patch[] = [];

      allPatches.push(...patcher.write('{"content":"'));
      allPatches.push(...patcher.write("This is ")); // add (first value)
      allPatches.push(...patcher.write("a long ")); // append
      allPatches.push(...patcher.write("string that ")); // append
      allPatches.push(...patcher.write("gets streamed ")); // append
      allPatches.push(...patcher.write("in many parts")); // append
      allPatches.push(...patcher.write('"}'));
      allPatches.push(...patcher.end());

      // Filter patches for /content path (excluding the initial add)
      const contentUpdatePatches = allPatches.filter(
        (p) => p.path === "/content" && p.op !== "add",
      );

      // All updates should be append, never replace
      for (const patch of contentUpdatePatches) {
        expect(patch.op).toBe("append");
      }

      // Verify we got the expected number of append operations (4 appends after initial add)
      expect(contentUpdatePatches.length).toBe(4);
    });

    it("handles strings in deeply nested arrays", () => {
      const patcher = new JSONPatcher({ allowedPartialPaths: ["/0/0/0"] });

      expect(patcher.write('[[["deep')).toEqual([
        { op: "replace", path: "/", value: [] },
        { op: "add", path: "/0", value: [] },
        { op: "add", path: "/0/0", value: [] },
        { op: "add", path: "/0/0/0", value: "deep" },
      ]);

      expect(patcher.write(" string")).toEqual([
        { op: "append", path: "/0/0/0", value: " string" },
      ]);

      expect(patcher.write('"]]]')).toEqual([]);
      expect(patcher.end()).toEqual([]);
    });

    it("does not emit partial updates for paths not in allowedPartialPaths", () => {
      const patcher = new JSONPatcher({ allowedPartialPaths: ["/allowed"] });

      // Start with a path that is allowed for partial updates
      expect(patcher.write('{"allowed":"first')).toEqual([
        { op: "replace", path: "/", value: {} },
        { op: "add", path: "/allowed", value: "first" },
      ]);

      // This should emit an append since /allowed is in allowedPartialPaths
      expect(patcher.write(" part")).toEqual([
        { op: "append", path: "/allowed", value: " part" },
      ]);

      // Now test a path that is NOT allowed for partial updates
      expect(patcher.write('","notAllowed":"second')).toEqual([]);

      // This should NOT emit an append since /notAllowed is not in allowedPartialPaths
      expect(patcher.write(" part")).toEqual([]);

      expect(patcher.write('"}')).toEqual([
        { op: "add", path: "/notAllowed", value: "second part" },
      ]);
      expect(patcher.end()).toEqual([]);
    });
    it("emits partial updates only for allowed paths when streaming", () => {
      const patcher = new JSONPatcher({ allowedPartialPaths: ["/allowed"] });

      expect(patcher.write('{"notAllowed":"first')).toEqual([
        { op: "replace", path: "/", value: {} },
      ]);
      expect(patcher.write(' part",')).toEqual([
        { op: "add", path: "/notAllowed", value: "first part" },
      ]);

      expect(patcher.write('"allowed":"first')).toEqual([
        { op: "add", path: "/allowed", value: "first" },
      ]);

      expect(patcher.write(' part"')).toEqual([
        { op: "append", path: "/allowed", value: " part" },
      ]);

      expect(patcher.write("}")).toEqual([]);
      expect(patcher.end()).toEqual([]);
    });
  });

  describe("top-level literal strings", () => {
    it("Shouldn't emit top level string chunks when allowedPartialPaths doesn't include the root", () => {
      const patcher = new JSONPatcher({ allowedPartialPaths: [] });

      expect(patcher.write('"first')).toEqual([]);
      expect(patcher.write(' part"')).toEqual([]);
      expect(patcher.end()).toEqual([
        { op: "replace", path: "/", value: "first part" },
      ]);
    });

    it("Should emit top level string chunks when allowedPartialPaths includes the root", () => {
      const patcher = new JSONPatcher({ allowedPartialPaths: ["/"] });

      expect(patcher.write('"first')).toEqual([
        { op: "replace", path: "/", value: "first" },
      ]);
      expect(patcher.write(' part"')).toEqual([
        { op: "append", path: "/", value: " part" },
      ]);
      expect(patcher.end()).toEqual([]);
    });
  });
});
