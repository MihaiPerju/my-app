#!/usr/bin/env bun
/**
 * build-python.ts — build every capability's Python distribution into the
 * complete internal `dist/py/` set and copy the strict public subset to
 * `dist/py-public/`. Public eligibility comes from the validated publication
 * graph shared with the hard gate. Pre-condition: `prepare-publish-python.ts`
 * already stamped the version.
 *
 *   bun scripts/release/build-python.ts <version>
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { $ } from "bun";

import { validatedPublicCapabilities } from "../registry/publication-check";
import { localCapabilityId } from "../shared/capability-identity";
import { readManifests } from "../shared/manifests";
import { REGISTRY_ID } from "./package-manifests";
import { copyPythonArtifacts, resetPythonArtifactOutputs } from "./public-python-artifacts";

/**
 * Env vars passed through to the untrusted `uv build`: build essentials only.
 * All release secrets are withheld, because a capability's PEP 517 build backend
 * is arbitrary PR-controlled code. Add a key only if a real build needs it.
 */
const BUILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LANGUAGE",
  "LC_CTYPE",
  "TERM",
  "USER",
  "LOGNAME",
  "SOURCE_DATE_EPOCH",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "UV_CACHE_DIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

export type PythonBuildRunner = (
  pyDir: string,
  environment: Readonly<Record<string, string>>,
) => Promise<void>;

export interface BuildLogger {
  log(message: string): void;
  error(message: string): void;
}

/** The replacement environment passed to each untrusted PEP 517 backend. */
export function pythonBuildEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
) {
  const environment: Record<string, string> = {};
  for (const key of BUILD_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

const runUvBuild: PythonBuildRunner = async (pyDir, environment) => {
  // `.env()` replaces the child env, so the untrusted backend sees nothing else.
  // `--no-config` prevents PR-controlled uv config from redirecting resolution.
  await $`uv build --no-config --out-dir dist`.cwd(pyDir).env(environment).quiet();
};

export async function buildPythonDistributions(
  root: string,
  version: string,
  runBuild: PythonBuildRunner = runUvBuild,
  logger: BuildLogger = console,
): Promise<{ built: number; publicBuilt: number }> {
  const capsDir = join(root, "capabilities");
  const outputs = resetPythonArtifactOutputs(root);
  const buildEnvironment = pythonBuildEnvironment();
  const failed: string[] = [];
  let built = 0;
  let publicBuilt = 0;

  // Only walk roots when the tier exists; readManifests would throw ENOENT otherwise.
  const capabilities = existsSync(capsDir) ? readManifests(root) : [];
  const publicCapabilityIds = new Set(
    validatedPublicCapabilities(capabilities, REGISTRY_ID, "capabilities", root).map(
      localCapabilityId,
    ),
  );
  for (const capability of capabilities) {
    const { id, path } = capability;
    if (!capability.packages?.includes("py")) continue;
    const pyDir = join(capsDir, path, "package", "py");
    const pyproject = join(pyDir, "pyproject.toml");
    if (!existsSync(pyproject) || !statSync(pyproject).isFile()) continue;

    const stage = join(pyDir, "dist");
    rmSync(stage, { recursive: true, force: true });
    try {
      // Every Python capability is built and retained internally. The public
      // decision controls only the secondary copy, never whether untrusted build
      // code runs here, so the existing secretless build trust boundary remains.
      await runBuild(pyDir, buildEnvironment);
      const artifacts = readdirSync(stage).filter(
        (file) => file.endsWith(".whl") || file.endsWith(".tar.gz"),
      );
      if (artifacts.length === 0) throw new Error("uv build produced no artifacts");

      const isPublic = publicCapabilityIds.has(localCapabilityId(capability));
      copyPythonArtifacts(stage, artifacts, outputs, isPublic);
      logger.log(`built ${id} @ ${version} (${artifacts.join(", ")})`);
      built++;
      if (isPublic) publicBuilt++;
    } catch (error) {
      logger.error(`FAILED ${id}: ${error instanceof Error ? error.message : String(error)}`);
      failed.push(id);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }

  if (failed.length > 0) {
    throw new Error(`${failed.length} dist(s) failed: ${failed.join(", ")}`);
  }
  logger.log(
    `Built ${built} Python dist(s) at ${version} into dist/py; ${publicBuilt} public dist(s) into dist/py-public.`,
  );
  return { built, publicBuilt };
}

async function main(): Promise<void> {
  const [version, extra] = process.argv.slice(2);
  if (!version || extra !== undefined) {
    throw new Error("usage: build-python.ts <version>");
  }
  await buildPythonDistributions(process.cwd(), version);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
