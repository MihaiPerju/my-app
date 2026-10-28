import { describe, expect, it } from "vitest";

import { parseSpecExamples } from "../../src/spec-harness/index.js";
import { commonmarkSampleSpec, gfmExtensionsSampleSpec } from "./fixtures.js";

describe("parseSpecExamples", () => {
  it("extracts CommonMark-style examples with sections and line numbers", () => {
    const examples = parseSpecExamples(commonmarkSampleSpec, {
      suite: "commonmark",
      sourcePath: "fixtures/commonmark-sample.txt",
    });

    expect(examples).toHaveLength(2);
    expect(examples[0]).toMatchObject({
      suite: "commonmark",
      number: 1,
      section: "Tabs",
      startLine: 3,
      endLine: 7,
      markdown: "line 1\n",
      html: "<p>line 1</p>\n",
      extensions: [],
      sourcePath: "fixtures/commonmark-sample.txt",
    });
    expect(examples[1]).toMatchObject({
      number: 2,
      section: "Links",
      markdown: "[x](y)\n",
      html: '<p><a href="y">x</a></p>\n',
    });
  });

  it("extracts optional extension tags from GFM-style examples", () => {
    const examples = parseSpecExamples(gfmExtensionsSampleSpec, {
      suite: "gfm-extensions",
    });

    expect(examples).toHaveLength(1);
    expect(examples[0]?.extensions).toEqual(["table", "strikethrough"]);
  });
});
