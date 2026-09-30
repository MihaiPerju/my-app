import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { buildDescriptor } from "../../../scripts/registry/build-registry";
import { withRepo, writeCap } from "../support/registry-fixture";
import { readJson, REGISTRY_ROOT } from "../support/template-tree";

interface ProjectedCapability {
  metadata?: object;
  public?: boolean;
}

const expectPublicationMetadataOmitted = (capabilities: ProjectedCapability[]): void => {
  for (const capability of capabilities) {
    expect(Object.hasOwn(capability, "metadata")).toBe(false);
    expect(Object.hasOwn(capability, "public")).toBe(false);
  }
};

describe("publication metadata descriptor boundary", () => {
  test("metadata.public does not project into a generated v3 descriptor", () => {
    withRepo(
      (root) => {
        writeCap(root, "feature/published", {
          id: "published",
          version: "1.0.0",
          kind: "feature",
          metadata: { public: true },
        });
      },
      (root) => {
        // SAFETY: buildDescriptor produced this JSON from the fixture directly
        // above; the test reads only its mandatory capabilities array.
        const descriptor = JSON.parse(buildDescriptor(root)) as {
          capabilities: ProjectedCapability[];
        };
        expectPublicationMetadataOmitted(descriptor.capabilities);
      },
    );
  });

  test("metadata.public does not appear in the committed v3 descriptor", () => {
    const descriptor = readJson<{ capabilities: ProjectedCapability[] }>(
      join(REGISTRY_ROOT, "registry.json"),
    );
    expectPublicationMetadataOmitted(descriptor.capabilities);
  });
});
