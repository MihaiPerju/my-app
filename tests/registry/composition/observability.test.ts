import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { capabilities, closure, renderHbs, toLocalId } from "../support/selection";
import { REGISTRY_ROOT } from "../support/template-tree";

const read = (path: string) => readFileSync(resolve(REGISTRY_ROOT, path), "utf8");

describe("Observability capability", () => {
  test("is opt-in and enables both SDK tracing surfaces", () => {
    const observability = capabilities.get(toLocalId("observability"));

    expect(observability?.default).not.toBe(true);
    expect(observability?.dependencies).toEqual(["core"]);
    expect(observability?.packages).toEqual(["ts", "py"]);
    expect(observability?.envVars).toMatchObject({
      MISTRAL_OTLP_TRACES_ENDPOINT: "https://api.mistral.ai/telemetry/v1/traces",
      MISTRAL_SDK_TELEMETRY: "dedicated",
      OTEL_ENABLED: "true",
    });
  });

  test("installs the SDK telemetry extra", () => {
    const pyproject = read("capabilities/feature/observability/package/py/pyproject.toml");

    expect(pyproject).toContain("mistralai[telemetry]>=2.9.4,<3");
    expect(pyproject).toContain('module-name = "mistralai_capabilities.observability"');
  });

  test("lets the generated environment override the container tracing default", () => {
    for (const file of ["compose.workflows.yaml", "compose.workflows.dev.yaml"]) {
      const compose = read(
        `capabilities/deployment/docker-compose-workflows/template/deploy/compose/${file}.hbs`,
      );
      expect(compose.indexOf("path: workflows.defaults.env")).toBeLessThan(
        compose.indexOf("path: ../../.env"),
      );
      expect(compose).not.toContain("OTEL_ENABLED:");

      const enabled = renderHbs(compose, new Set(["core", "workflows", "observability"]));
      const disabled = renderHbs(compose, new Set(["core", "workflows"]));
      expect(enabled).toContain('MISTRAL_SDK_TELEMETRY: "global"');
      expect(disabled).not.toContain("MISTRAL_SDK_TELEMETRY");
    }
    expect(
      read(
        "capabilities/deployment/docker-compose-workflows/template/deploy/compose/workflows.defaults.env",
      ),
    ).toContain("OTEL_ENABLED=false");
  });

  test("gates Helm telemetry by selection", () => {
    const umbrella = read("capabilities/deployment/helm/template/deploy/helm/app/values.yaml.hbs");
    const helpers = read(
      "capabilities/deployment/helm/template/deploy/helm/app/charts/common/templates/_helpers.tpl",
    );
    const workflow = read(
      "capabilities/deployment/helm-workflows/template/deploy/helm/app/charts/workflows/values.yaml.hbs",
    );
    const workloads = closure(["fastapi", "workflows", "helm"]);
    const enabled = renderHbs(umbrella, closure(["fastapi", "workflows", "helm", "observability"]));
    const disabled = renderHbs(umbrella, workloads);

    expect(enabled.match(/MISTRAL_SDK_TELEMETRY: "dedicated"/g)).toHaveLength(2);
    expect(enabled.match(/MISTRAL_SDK_TELEMETRY: "global"/g)).toHaveLength(1);
    expect(enabled.match(/mistralOtlpTracesEndpoint:/g)).toHaveLength(1);
    expect(helpers).toContain("- name: MISTRAL_OTLP_TRACES_ENDPOINT");
    expect(helpers).toContain('or (eq $component "api") (hasPrefix "init-" $component)');
    expect(enabled).toContain('OTEL_ENABLED: "true"');
    expect(disabled).not.toContain("MISTRAL_SDK_TELEMETRY");
    expect(disabled).not.toContain("mistralOtlpTracesEndpoint");
    expect(disabled).not.toContain("OTEL_ENABLED");
    expect(workflow).toContain('OTEL_ENABLED: "false"');
  });

  test("ships safe custom-span guidance", () => {
    const skill = read(
      "capabilities/feature/observability/template/.agents/skills/observe/SKILL.md",
    );

    expect(skill).toContain("get_telemetry_tracer(client, __name__)");
    expect(skill).toContain('f"execute_tool {tool_name}"');
    expect(skill).toContain('"gen_ai.operation.name": "execute_tool"');
    expect(skill).toContain("Prompt and response content, including tool arguments and results");
    expect(skill).toContain("Never attach API keys, authorization headers");
    expect(skill).toContain("Do not duplicate Mistral SDK");
    expect(skill).toContain("MISTRAL_OTLP_TRACES_ENDPOINT");
    expect(skill).toContain("SERVER_URL");
  });
});
