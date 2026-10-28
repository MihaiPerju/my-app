import { describe, expect, it } from "vitest";

import {
  buildSpecInventory,
  filterSpecExamples,
  parseSpecExamples,
  runSpecHarness,
} from "../../src/spec-harness/index.js";
import { commonmarkSampleSpec } from "./fixtures.js";

describe("filterSpecExamples", () => {
  it("filters by section and example number", () => {
    const examples = parseSpecExamples(commonmarkSampleSpec, {
      suite: "commonmark",
    });

    expect(
      filterSpecExamples(examples, {
        onlyNumber: 2,
      }),
    ).toHaveLength(1);

    expect(
      filterSpecExamples(examples, {
        sectionPattern: /tabs/iu,
      }),
    ).toHaveLength(1);
  });
});

describe("buildSpecInventory", () => {
  it("aggregates section counts", () => {
    const examples = parseSpecExamples(commonmarkSampleSpec, {
      suite: "commonmark",
    });

    expect(buildSpecInventory(examples, "commonmark")).toMatchObject({
      suite: "commonmark",
      totalExamples: 2,
      totalSections: 2,
      sections: [
        { section: "Links", exampleCount: 1 },
        { section: "Tabs", exampleCount: 1 },
      ],
    });
  });
});

describe("runSpecHarness", () => {
  it("computes summary counts and rates", async () => {
    const examples = parseSpecExamples(commonmarkSampleSpec, {
      suite: "commonmark",
    });

    const report = await runSpecHarness(
      examples,
      {
        name: "fake",
        evaluate(example) {
          if (example.number === 1) {
            return { status: "pass" } as const;
          }

          return { status: "not_implemented" } as const;
        },
      },
      "commonmark",
    );

    expect(report).toMatchObject({
      suite: "commonmark",
      adapterName: "fake",
      totalExamples: 2,
      implementedExamples: 1,
      counts: {
        pass: 1,
        fail: 0,
        notImplemented: 1,
        error: 0,
        skip: 0,
      },
      passRate: 0.5,
      implementedRate: 0.5,
    });
  });
});
