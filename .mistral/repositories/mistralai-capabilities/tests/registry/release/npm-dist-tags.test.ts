import { describe, expect, test } from "bun:test";

import { DEFAULT_PACKAGE_REGISTRY } from "../../../scripts/release/package-registries";
import { distTagFor, planFor, type PlanEntry } from "../../../scripts/release/publish-plan";

/**
 * `latest` is what every untagged `bun add @mistralai-capabilities/<id>` resolves to. Both indexes
 * hand it out by default -- npm to whatever was published last, Cloudsmith to the semantically
 * highest version present -- so a release candidate for 0.1.3, published while 0.1.2 is the
 * release, takes it from under the customers unless every upload states its tag. The tag is
 * derived from the version rather than passed down the pipeline, because the caller that could
 * pass the wrong one is the one that must not.
 */
describe("npm dist tags", () => {
  test("a release takes latest and a candidate takes rc", () => {
    expect(distTagFor("0.1.3")).toBe("latest");
    expect(distTagFor("0.1.3-rc52309221")).toBe("rc");
  });

  test("the plan hands every uploader the tag alongside the tarball", () => {
    const plan: PlanEntry[] = [
      { name: "@mistralai-capabilities/chat", version: "0.1.3-rc52309221", tarball: "chat.tgz" },
      {
        name: "@mistralai-capabilities/registry",
        version: "0.1.3-rc52309221",
        tarball: `descriptor/${DEFAULT_PACKAGE_REGISTRY}/registry.tgz`,
        registry: DEFAULT_PACKAGE_REGISTRY,
      },
    ];
    // Every entry an index uploads, candidate or release, carries one tag.
    expect(planFor(DEFAULT_PACKAGE_REGISTRY, plan).map((e) => distTagFor(e.version))).toEqual([
      "rc",
      "rc",
    ]);
  });
});
