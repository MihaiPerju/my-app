/**
 * Two apps generated from this registry must run side by side on one host, and each must honour the
 * host ports its root `.env` sets.
 *
 * Every assertion here is a bug found by building apps from the registry:
 *  - every Compose file said `name: app`, so a second app took over the first one's containers, and
 *    the shared `app-init:local` tag let one app's build overwrite another's init image;
 *  - host ports were literals, so the documented GATEWAY_PORT/API_PORT/WEB_PORT did nothing;
 *  - `tools/compose.sh` never passed the root `.env` (Compose's project directory is deploy/compose),
 *    and ran `--remove-orphans` against that shared project;
 *  - the Keycloak client and the API's CORS origin only accepted `localhost:9080`;
 *  - once `.env` reached Compose, a customised GATEWAY_OIDC_CLIENT_SECRET reached APISIX but not the
 *    Keycloak client, whose imported secret was a literal, so every login failed;
 *  - Keycloak splices a realm placeholder in as raw text, so a secret holding `"` or `\` broke the
 *    realm import ("Unexpected character ... was expecting comma to separate Object entries");
 *  - smoke.sh read `.env` with `sed`, so `API_PORT="13000"` or an inline comment gave it a port
 *    Compose never published;
 *  - the realm and the web app's title/brand carried the registry's name, not the app's;
 *  - the gateway dropped the Vite HMR WebSocket upgrade.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { capabilities } from "../support/selection";
import { capabilityLocalIds, templateDir } from "../support/template-tree";

const ROOTS = new Set(["compose.yaml.hbs", "compose.dev.yaml.hbs"]);

type ComposeFile = { owner: string; file: string; text: string };

const composeFiles: ComposeFile[] = capabilityLocalIds.flatMap((owner) => {
  const dir = join(templateDir(owner), "deploy", "compose");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => /\.ya?ml(?:\.hbs)?$/.test(file))
    .map((file) => ({ owner, file, text: readFileSync(join(dir, file), "utf8") }));
});

const templateFile = (id: string, rel: string): string =>
  readFileSync(join(templateDir(id), rel), "utf8");

// Every envVar default declared anywhere in the registry, by name.
const envDefaults = new Map<string, string>();
for (const [, capability] of capabilities) {
  for (const [name, value] of Object.entries(capability.envVars ?? {}))
    envDefaults.set(name, value);
}

describe("compose project isolation", () => {
  test("the compose template set is non-empty", () => {
    expect(composeFiles.length).toBeGreaterThan(5);
    for (const root of ROOTS) {
      expect(
        composeFiles.some(({ file }) => file === root),
        `${root} missing`,
      ).toBe(true);
    }
  });

  test("each root names the project after the app; overlays name nothing", () => {
    const offenders: string[] = [];
    for (const { owner, file, text } of composeFiles) {
      const names = [...text.matchAll(/^name:\s*(.*)$/gm)].map((m) => m[1]!.trim());
      if (ROOTS.has(file)) {
        if (names.length !== 1 || names[0] !== "{{projectName}}") {
          offenders.push(`${owner}/${file}: name ${JSON.stringify(names)}`);
        }
      } else if (names.length > 0) {
        // An included file's name is ignored by Compose, and a literal one (`app`) is exactly what
        // made two apps share a project whenever an overlay was run on its own.
        offenders.push(`${owner}/${file}: name ${JSON.stringify(names)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("a locally built image tag is namespaced by the project", () => {
    const offenders = composeFiles.flatMap(({ owner, file, text }) =>
      [...text.matchAll(/^\s*image:\s*(\S+:local)\s*$/gm)]
        .map((m) => m[1]!)
        .filter((image) => !image.startsWith("${COMPOSE_PROJECT_NAME}-"))
        .map((image) => `${owner}/${file}: ${image}`),
    );
    expect(offenders).toEqual([]);
  });

  test("every published host port is an envVar-declared *_PORT with a matching default", () => {
    const offenders: string[] = [];
    let published = 0;
    for (const { owner, file, text } of composeFiles) {
      const lines = text.split("\n");
      lines.forEach((line, index) => {
        const mapping = /^\s*-\s*"(.+):(\d+)"\s*$/.exec(line);
        if (!mapping) return;
        // Only entries of a `ports:` list: walk back to the nearest key at a shallower indent.
        const indent = line.search(/\S/);
        const parent = lines
          .slice(0, index)
          .toReversed()
          .find((candidate) => /\S/.test(candidate) && candidate.search(/\S/) < indent);
        if (parent?.trim() !== "ports:") return;
        published += 1;
        const host = mapping[1]!.replace(/^127\.0\.0\.1:/, "");
        const variable = /^\$\{([A-Z][A-Z0-9_]*_PORT):-(\d+)\}$/.exec(host);
        if (!variable) {
          offenders.push(`${owner}/${file}: "${mapping[0]!.trim()}" publishes a literal host port`);
          return;
        }
        const [, name, fallback] = variable;
        if (envDefaults.get(name!) !== fallback) {
          offenders.push(
            `${owner}/${file}: ${name} defaults to ${fallback} here but envVars say ${envDefaults.get(name!)}`,
          );
        }
      });
    }
    expect(published).toBeGreaterThan(5);
    expect(offenders).toEqual([]);
  });

  // compose.sh hands the root .env to Compose, so any `${VAR}` in a Compose file is now read from
  // it. A host-side loopback URL there (MCP_SERVER_URL=http://localhost:3000/mcp) would point a
  // container at itself.
  test("no container setting is interpolated from a host-loopback .env value", () => {
    const offenders = composeFiles.flatMap(({ owner, file, text }) =>
      [...text.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)]
        .map((m) => m[1]!)
        .filter((name) => /\/\/(localhost|127\.0\.0\.1)[:/]/.test(envDefaults.get(name) ?? ""))
        .map((name) => `${owner}/${file}: \${${name}} = ${envDefaults.get(name)}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe("tools/compose.sh", () => {
  const script = templateFile("docker-compose", "tools/compose.sh");

  test("every docker compose call reads the root .env", () => {
    expect(script).toContain("ENV_FILE=(--env-file .env)");
    const calls = script.split("\n").filter((line) => /^\s*[^#]*docker compose\b/.test(line));
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('"${ENV_FILE[@]}"');
  });

  // The behaviour (renew only after a rebuild, extra arguments forwarded) is exercised against a
  // fake docker by the template's own tests/test_deploy_compose_tasks.py in every generated app.
  test("dev renews anonymous volumes after a rebuild and never removes orphans by default", () => {
    const code = script
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(code).not.toContain("--remove-orphans");
    expect(code).toContain("renew=(--renew-anon-volumes)");
  });

  test("the smoke runbook reads the root .env for both Compose and its probes", () => {
    const smoke = templateFile("docker-compose", "tools/smoke.sh.hbs");
    expect(smoke).toContain("DC+=(--env-file .env)");
    // The probes take Compose's own interpolation environment (quotes and inline comments parsed by
    // Compose), never a hand-rolled read of .env. The behaviour is exercised against a fake and a
    // real docker by the template's tests/test_deploy_compose_tasks.py.
    expect(script).toContain('dc "$COMPOSE" config --environment');
    expect(smoke).toContain('COMPOSE_ENV="$(bash "${SCRIPT_DIR}/compose.sh" env');
    for (const name of [
      "API_PORT",
      "WEB_PORT",
      "GATEWAY_PORT",
      "KEYCLOAK_PORT",
      "GATEWAY_OIDC_CLIENT_SECRET",
    ]) {
      expect(smoke, name).toContain(`$(compose_value ${name})`);
    }
    const code = smoke
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(/\.env\s*\|/);
    expect(code).not.toMatch(/(sed|grep|awk|cut)\b[^\n]*\s\.env\b/);
  });
});

describe("gateway port and realm follow the app", () => {
  const realm = templateFile("docker-compose-auth", "deploy/docker/keycloak/realm.json.hbs");
  const gateway = templateFile("docker-compose-auth", "deploy/compose/compose.gateway.yaml.hbs");
  const apisix = templateFile("docker-compose-auth", "deploy/docker/gateway/apisix.yaml.hbs");
  const smoke = templateFile("docker-compose", "tools/smoke.sh.hbs");

  test("the Keycloak client accepts the published gateway port, not a literal 9080", () => {
    // SAFETY: realm.json is a repo-owned Keycloak realm export; a shape change fails the loop below.
    const client = JSON.parse(realm.replaceAll("{{projectName}}", "probe")) as {
      clients: {
        redirectUris: string[];
        webOrigins: string[];
        attributes: Record<string, string>;
      }[];
    };
    for (const { redirectUris, webOrigins, attributes } of client.clients) {
      for (const uri of [
        ...redirectUris,
        ...webOrigins,
        attributes["post.logout.redirect.uris"]!,
      ]) {
        // Keycloak resolves `${VAR:default}` from its environment at realm import.
        expect(uri).toStartWith("http://localhost:${GATEWAY_PORT:9080}");
      }
    }
    expect(gateway).toContain("GATEWAY_PORT: ${GATEWAY_PORT:-9080}");
    expect(
      templateFile("docker-compose-auth", "deploy/compose/compose.api.auth.dev.yaml"),
    ).toContain("CORS_ORIGIN: http://localhost:${GATEWAY_PORT:-9080}");
  });

  test("the Keycloak client secret follows the gateway's GATEWAY_OIDC_CLIENT_SECRET", () => {
    // The root .env reaches the gateway, so a customised secret there must reach the imported
    // client too. Keycloak resolves `${VAR:default}` from its environment at realm import.
    const fallback = envDefaults.get("GATEWAY_OIDC_CLIENT_SECRET");
    expect(fallback).toBeTruthy();
    // SAFETY: realm.json is a repo-owned Keycloak realm export; a shape change fails the loop below.
    const { clients } = JSON.parse(realm.replaceAll("{{projectName}}", "probe")) as {
      clients: { publicClient: boolean; secret?: string }[];
    };
    const confidential = clients.filter((client) => !client.publicClient);
    expect(confidential.length).toBeGreaterThan(0);
    for (const client of confidential) {
      expect(client.secret).toBe(`\${GATEWAY_OIDC_CLIENT_SECRET_JSON:${fallback}}`);
    }
    const passed = [...gateway.matchAll(/^\s*GATEWAY_OIDC_CLIENT_SECRET:\s*(\S+)\s*$/gm)].map(
      (m) => m[1],
    );
    // Once for Keycloak's import, once for the gateway, with the same default.
    expect(passed).toEqual([
      `\${GATEWAY_OIDC_CLIENT_SECRET:-${fallback}}`,
      `\${GATEWAY_OIDC_CLIENT_SECRET:-${fallback}}`,
    ]);
    const keycloak = gateway.slice(gateway.indexOf("  keycloak:"), gateway.indexOf("  gateway:"));
    expect(keycloak).toContain("GATEWAY_OIDC_CLIENT_SECRET: ${GATEWAY_OIDC_CLIENT_SECRET:-");
  });

  test("any printable client secret survives Keycloak's realm import", () => {
    // Keycloak replaces `${VAR:default}` in realm.json as raw text and parses the JSON afterwards,
    // so the Keycloak entrypoint JSON-escapes the secret into GATEWAY_OIDC_CLIENT_SECRET_JSON. Run
    // that entrypoint script (Compose's `$$` unescaped, kc.sh swapped for a print) and import the
    // realm the way Keycloak does: substitute the text, then parse.
    const lines = gateway.slice(gateway.indexOf("  keycloak:")).split("\n");
    const start = lines.findIndex((line) => line.trim() === "- |") + 1;
    const end = lines.findIndex((line, index) => index >= start && line.trim() === "- kc.sh");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const entrypoint = lines
      .slice(start, end)
      .map((line) => line.slice(8))
      .join("\n")
      .replaceAll("$$", "$");
    expect(entrypoint).toContain('exec /opt/keycloak/bin/kc.sh "$@"');
    const script = entrypoint.replace(
      'exec /opt/keycloak/bin/kc.sh "$@"',
      'printf %s "$GATEWAY_OIDC_CLIENT_SECRET_JSON"',
    );
    const runEntrypoint = (secret: string) =>
      Bun.spawnSync(["bash", "-c", script, "kc.sh"], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GATEWAY_OIDC_CLIENT_SECRET: secret },
      });
    const template = realm.replaceAll("{{projectName}}", "probe");
    for (const secret of [
      "dev-client-secret",
      'we"ird\\sec}ret:x',
      '\\"',
      "a\\\\b",
      "$HOME",
      "`x`",
    ]) {
      const run = runEntrypoint(secret);
      expect(run.exitCode, secret).toBe(0);
      const escaped = run.stdout.toString();
      const imported = template.replace(
        /\$\{GATEWAY_OIDC_CLIENT_SECRET_JSON:[^}]*\}/,
        () => escaped,
      );
      // SAFETY: realm.json is a repo-owned Keycloak realm export; the parse is the assertion.
      const parsed = JSON.parse(imported) as { clients: { secret?: string }[] };
      expect(parsed.clients.map((client) => client.secret)).toContain(secret);
    }
    // A control character cannot be carried through; the entrypoint refuses it with a message.
    const refused = runEntrypoint("tab\there");
    expect(refused.exitCode).toBe(64);
    expect(refused.stderr.toString()).toContain("GATEWAY_OIDC_CLIENT_SECRET");
  });

  test("the realm is named after the app everywhere it is referenced", () => {
    expect(JSON.parse(realm.replaceAll("{{projectName}}", "probe")).realm).toBe("probe");
    const references = [...apisix.matchAll(/realms\/([^/\s]+)\//g)].map((m) => m[1]);
    expect(references.length).toBeGreaterThan(0);
    expect(new Set(references)).toEqual(new Set(["{{projectName}}"]));
    const realmFields = [...apisix.matchAll(/^\s*realm:\s*(\S+)$/gm)].map((m) => m[1]);
    expect(realmFields.length).toBeGreaterThan(0);
    expect(new Set(realmFields)).toEqual(new Set(["{{projectName}}"]));
    expect(smoke).toContain('APP_REALM="{{projectName}}"');
    for (const text of [realm, apisix, smoke]) {
      expect(text).not.toContain("mistralai-capabilities");
      expect(text).not.toContain("Solutions Capabilities");
    }
  });

  test("the web catch-all route passes WebSocket upgrades (Vite HMR)", () => {
    const route = apisix.slice(apisix.indexOf("- uri: /*"));
    expect(route.slice(0, route.indexOf("upstream:"))).toContain("enable_websocket: true");
  });
});

describe("web branding follows the app", () => {
  const web = (rel: string) => templateFile("tanstack-start", join("apps/web/src", rel));
  const shell = (rel: string) => templateFile("mistral-design-system", join("apps/web/src", rel));

  test("the title and the sidebar brand read APP_NAME, the app's name from the root .env", () => {
    // At render time the server's own APP_NAME wins; the build-time name is the fallback.
    expect(web("app-name.ts")).toContain('process.env["APP_NAME"]');
    expect(web("app-name.ts")).toContain("import.meta.env.APP_NAME");
    const viteConfig = templateFile("tanstack-start", "apps/web/vite.config.ts");
    expect(viteConfig).toContain('"import.meta.env.APP_NAME"');
    expect(viteConfig).toContain('loadEnv(mode, WORKSPACE_ROOT, "APP_NAME")');
    // The root .env is not in the image's build context, so the image takes the name as an arg.
    expect(templateFile("tanstack-start", "deploy/docker/Dockerfile.web")).toContain(
      "ARG APP_NAME",
    );
    expect(templateFile("docker-compose-web", "deploy/compose/compose.web.yaml.hbs")).toContain(
      "APP_NAME: ${APP_NAME:-}",
    );
    // The browser adopts the server's answer through the router's dehydrated state.
    expect(web("router.tsx")).toContain("dehydrate: () => ({ appName: context.appName })");
    expect(web("routes/__root.tsx")).toContain("title: match.context.appName");
    expect(shell("shell/app-shell.tsx")).toContain("useAppName()");
    expect(web("routes/__root.tsx")).not.toContain("Capabilities");
    expect(shell("shell/app-shell.tsx")).not.toContain("Capabilities");
  });
});
