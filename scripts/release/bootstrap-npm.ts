#!/usr/bin/env bun
/**
 * bootstrap-npm.ts — create the packages a first release has nothing to stage against.
 *
 * The one publish in this pipeline that is not OIDC. npm will only attach a
 * trusted publisher to a package that already exists, so a capability going
 * public needs its name on npmjs.org before the staging job can reach it. This
 * logs in as the service user through npm's web flow, publishes an empty
 * `0.0.0` for each named package, and attaches the stage-only trusted publisher.
 *
 * npm's web login prints a URL and polls for the answer, so nothing has to
 * listen on this machine and it runs in CI. The person holding the service-user
 * passkey opens that URL and ticks npm's "skip two-factor authentication for
 * the next 5 minutes" box; every publish and `npm trust` below runs inside that
 * window, which is why they are one process and not one step each.
 *
 *   NPM_USERCONFIG=<path> bun scripts/release/bootstrap-npm.ts <package>...
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PACKAGE_REGISTRIES, PUBLIC_PACKAGE_REGISTRY } from "./package-registries";

const REGISTRY = PACKAGE_REGISTRIES[PUBLIC_PACKAGE_REGISTRY].ts;

/**
 * The skeleton's version, and the dist-tag it goes out under. npmjs.org points
 * `latest` at a package's first version whatever `--tag` asks for, so `bun add`
 * resolves to the empty skeleton until the real release is staged and approved.
 * That is what the deprecation below is for; `npm stage approve` moves `latest`
 * off it.
 */
const SKELETON_VERSION = "0.0.0";
const SKELETON_TAG = "bootstrap";
const SKELETON_DEPRECATION =
  "Placeholder so the release pipeline has a package to stage against. Install a released version instead.";

/** Run a command with this process's stdio, so npm's login URL appears as it is printed. */
function run(command: readonly string[], cwd?: string): Promise<number> {
  const [executable, ...args] = command;
  if (executable === undefined) throw new Error("cannot run an empty command");
  console.log(`$ ${command.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/**
 * A directory holding nothing but the skeleton manifest for `name`. The manifest
 * carries no licence: the grant belongs to the release the staging job puts out,
 * and this module stays free of the dependencies the rest of the release scripts
 * pull in, so the job that runs it needs no `bun install`.
 */
export function writeSkeleton(name: string, root: string): string {
  const dir = mkdtempSync(join(root, "skeleton-"));
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name, version: SKELETON_VERSION }, null, 2)}\n`,
  );
  return dir;
}

export function publishCommand(dir: string, userconfig: string): string[] {
  return [
    "npm",
    "publish",
    dir,
    "--userconfig",
    userconfig,
    "--registry",
    REGISTRY,
    "--access",
    "public",
    "--tag",
    SKELETON_TAG,
  ];
}

export function deprecateCommand(name: string, userconfig: string): string[] {
  return [
    "npm",
    "deprecate",
    `${name}@${SKELETON_VERSION}`,
    SKELETON_DEPRECATION,
    "--userconfig",
    userconfig,
    "--registry",
    REGISTRY,
  ];
}

export function trustCommand(
  name: string,
  { userconfig, repository, workflow, environment }: TrustTarget,
): string[] {
  return [
    "npm",
    "trust",
    "github",
    name,
    "--userconfig",
    userconfig,
    "--repo",
    repository,
    "--file",
    workflow,
    "--env",
    environment,
    // Stage-only. The staging job's OIDC token must not be able to make a
    // version installable without the separate `npm stage approve`.
    "--allow-stage-publish",
    "-y",
  ];
}

export interface TrustTarget {
  userconfig: string;
  repository: string;
  workflow: string;
  environment: string;
}

/**
 * The web flow rather than a prompt for a username and password. It is npm's
 * default, and naming it keeps a `~/.npmrc` or an `npm_config_auth_type` in the
 * runner image from turning this into a login that hangs waiting on stdin.
 */
export function loginCommand(userconfig: string): string[] {
  return ["npm", "login", "--userconfig", userconfig, "--registry", REGISTRY, "--auth-type", "web"];
}

export function targetFromEnvironment(env: NodeJS.ProcessEnv = process.env): TrustTarget {
  const required = (variable: string): string => {
    const value = env[variable];
    if (value === undefined || value.length === 0) throw new Error(`${variable} is required`);
    return value;
  };
  return {
    // Never `~/.npmrc`: the session this creates has publish rights over the
    // whole scope and must die with the directory the caller cleans up.
    userconfig: required("NPM_USERCONFIG"),
    repository: required("GITHUB_REPOSITORY"),
    workflow: env.NPM_TRUST_WORKFLOW ?? "publish.yaml",
    environment: env.NPM_TRUST_ENVIRONMENT ?? "publish",
  };
}

/** Runs one command and answers its exit code. */
export type CommandRunner = (command: readonly string[]) => Promise<number>;

/**
 * Log in once, then create each package, deprecate the skeleton and attach the
 * trusted publisher. Order matters twice over: npm will not trust a package that
 * does not exist, and the skeleton is installable as `latest` from the moment it
 * publishes, so the warning goes on before anything that might fail afterwards.
 * A failure anywhere stops the rest rather than leaving a half-created set
 * behind.
 */
export async function bootstrap(
  names: readonly string[],
  target: TrustTarget,
  runner: CommandRunner = run,
  skeletonRoot?: string,
): Promise<void> {
  if (names.length === 0) throw new Error("no packages to bootstrap");

  console.log(`Bootstrapping ${names.length} package(s): ${names.join(", ")}`);
  if ((await runner(loginCommand(target.userconfig))) !== 0) throw new Error("npm login failed");

  const root = skeletonRoot ?? mkdtempSync(join(tmpdir(), "npm-bootstrap-"));
  for (const name of names) {
    const dir = writeSkeleton(name, root);
    if ((await runner(publishCommand(dir, target.userconfig))) !== 0) {
      throw new Error(`failed to publish the ${name} skeleton`);
    }
    if ((await runner(deprecateCommand(name, target.userconfig))) !== 0) {
      throw new Error(
        `created ${name} but failed to deprecate its skeleton; ${name}@${SKELETON_VERSION} is ` +
          `installable as \`latest\` until the release is approved, so deprecate it by hand and ` +
          `attach its trusted publisher on npmjs.com before releasing`,
      );
    }
    if ((await runner(trustCommand(name, target))) !== 0) {
      throw new Error(
        `published the ${name} skeleton but failed to attach its trusted publisher; ` +
          `attach it by hand on npmjs.com before releasing`,
      );
    }
  }

  console.log(`Bootstrapped ${names.length} package(s).`);
}

if (import.meta.main) {
  try {
    await bootstrap(process.argv.slice(2), targetFromEnvironment());
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
