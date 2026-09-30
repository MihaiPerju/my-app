/**
 * The gateway's APISIX route table must match the selection.
 *
 * apisix.yaml is the standalone config the compose gateway mounts, owned by the hidden
 * docker-compose-auth integration. API and web are optional, so a route to an upstream that was
 * not vendored would only 502 — the API routes are gated on `has "fastapi"` and the web catch-all
 * on `has "tanstack-start"`. This renders the template for every selection and asserts each
 * upstream appears exactly when its capability is installed, that the file always
 * closes with the standalone `#END` marker, and that every APISIX env reference stays escaped so
 * Handlebars renders it back to a literal `${{…}}` rather than blanking the secret.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gatesIn, renderHbs, selectionsObserving, toLocalId } from "../support/selection";
import { capabilityDir } from "../support/template-tree";

const APISIX_SRC = readFileSync(
  join(
    capabilityDir("docker-compose-auth"),
    "template",
    "deploy",
    "docker",
    "gateway",
    "apisix.yaml.hbs",
  ),
  "utf8",
);

describe("the apisix route table degrades by capability", () => {
  test.each(
    selectionsObserving(gatesIn(APISIX_SRC)).map(({ label, present }) => [label, present] as const),
  )("%s routes only to upstreams that exist", (name, present) => {
    const rendered = renderHbs(APISIX_SRC, present);

    expect(rendered.includes('"api:3000"'), `${name}: api upstream`).toBe(
      present.has(toLocalId("fastapi")),
    );
    expect(rendered.includes('"web:3001"'), `${name}: web upstream`).toBe(
      present.has(toLocalId("tanstack-start")),
    );
    expect(rendered.trimEnd().endsWith("#END"), `${name}: standalone end marker`).toBe(true);
  });

  test("every APISIX env reference is escaped so Handlebars cannot blank the secret", () => {
    // A `$\{{VAR}}` renders to a literal `${{VAR}}`; a bare `${{VAR}}` would be consumed by
    // Handlebars and blank the secret. So no unescaped `${{` may appear, and the escaped form must.
    expect(APISIX_SRC.includes("$\\{{")).toBe(true);
    expect(APISIX_SRC.match(/(?<!\\)\$\{\{/g)).toBeNull();
  });
});
