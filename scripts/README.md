# Repository tooling

This directory contains repository automation, not code shipped in a generated application. Keep
CI configuration as wiring: decisions, validation, and filesystem transformations belong here so
they are typed or linted and can be tested outside the pipeline definition.

## Entry points

The stable developer commands live in the root `package.json`:

| Command                              | Entry point                                                        | Purpose                                                                      |
| ------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `bun run registry:build`             | `registry/build-registry.ts`, then `registry/app-registry-pins.ts` | Regenerate `registry.json` and core's committed default-index configuration. |
| `bun run registry:publication-check` | `registry/publication-check.ts`                                    | Enforce public capability eligibility and public dependency closure offline. |
| `bun run registry:check`             | Publication check, then the registry build entry points `--check`  | Run the eligibility gate and fail when committed generated files are stale.  |
| `bun run docs:build`                 | `registry/build-docs.ts`                                           | Regenerate the README capability table.                                      |
| `bun run docs:check`                 | The same entry point with `--check`                                | Fail when the table is stale.                                                |
| `bun run public-artifacts:check`     | `compliance/check-public-artifacts.ts`                             | Build public-candidate artifacts and reject private references in them.      |
| `bun run e2e`                        | `e2e/generate_app.py`                                              | Generate package- and git-acquired apps and exercise their composed output.  |

`.github/workflows/publish-core.yaml` and the compliance check share one canonical artifact build;
its lower-level stages remain available for focused release tests:

| Stage                                           | Entry point                                         |
| ----------------------------------------------- | --------------------------------------------------- |
| Prepare and build all publication artifacts     | `release/build-artifacts.ts <version>`              |
| Stamp npm and capability manifests              | `release/prepare-publish.ts <version>`              |
| Stamp Python distributions                      | `release/prepare-publish-python.ts <version>`       |
| Pack npm artifacts and write their routing plan | `release/pack-all.ts <version>`                     |
| Build internal and public Python artifact sets  | `release/build-python.ts <version>`                 |
| Publish npm artifacts to an internal registry   | `release/publish-npm.ts <registry-id> <upload-url>` |
| Print a registry's npm upload set               | `release/publish-plan.ts <registry-id>`             |
| Stage the public npm upload set on npmjs.org    | `release/stage-npm.ts`                              |
| Report which public packages npmjs.org lacks    | `release/npm-package-existence.ts`                  |
| Create missing public packages and trust CI     | `release/bootstrap-npm.ts <package>...`             |
| Report which public projects pypi.org holds     | `release/pypi-package-existence.ts [directory]`     |

Do not invoke release preparation in a working checkout you want to keep clean: it stamps versions
into manifests. CI uses an ephemeral checkout, and the package-transport E2E uses a temporary copy.

## Directory map

### `shared/`

Import-only utilities used by more than one subsystem:

- `manifests.ts` is the canonical capability scan, parser, and directory/id invariant.
- `generated-files.ts` implements the shared write-versus-check freshness protocol.

Neither file is an executable command.

### `compliance/`

`check-public-artifacts.ts` copies the authored checkout to a temporary directory, runs the same
prepare-and-build entry point as release CI, selects the public audience, and scans every packed
member name and byte payload for private infrastructure references. Release preparation may rewrite
the temporary checkout; the developer's checkout, including any existing `dist/`, remains untouched.

### `registry/`

- `build-registry.ts` projects `registry.config.json` plus every `capability.json` into the committed
  root `registry.json`. `release/pack-all.ts` also imports the pure builder after versions are
  stamped, so release descriptors carry the release version rather than the committed `0.0.0`.
- `app-registry-pins.ts` generates the registry pins of every `metadata.registryPins` carrier, for the
  template files each one lists there:
  mistral-design-system's `.npmrc`, and core's bun capability scope, uv index and registry
  username. Packing calls it once
  per package registry because consumers of Gemfury and Cloudsmith need different URLs and Python
  usernames.
- `build-docs.ts` derives the README capability table from the same manifests.
- `publication-check.ts` is the network-free hard gate for explicit publication metadata, public
  dependency closure, and at least one declared package language.

### `release/`

The release data flow is:

```text
prepare-publish.ts ─────────┐
package-registries.ts ──────┴─> pack-all.ts ─> dist/npm/ + publish-plan.json
                                                  ├─> Gemfury npm upload ────┐
                                                  ├─> Cloudsmith npm upload ─┤
                                                  └─> stage-npm.ts (public) <┘
prepare-publish-python.ts ────> build-python.ts
                                  ├─> dist/py/ ───────> Gemfury + Cloudsmith
                                  └─> dist/py-public/ ─> PyPI, then npm staging
```

Both public jobs are gated until the internal publication jobs have succeeded, and each takes its own
approval in the protected `publish` environment. PyPI goes first. A PyPI project name belongs to
whoever uploads to it first, and the npm bootstrap makes a new capability's name public as soon as it
publishes the skeleton, so uploading to PyPI before that closes the window in which the name can be
taken.

`pypi-package-existence.ts` asks pypi.org, unauthenticated, which of the projects in `dist/py-public/`
it already holds. Neither answer can fail the run: a pending publisher does not create the project,
so a correctly registered name still answers 404 until the first upload, and an existing project is
the normal state after a capability's first release. The report is there for the approval gate on
`publish-pypi`, where a name that is unexpectedly new, or one already held on a capability's first
public release, is what the maintainer has to notice before the upload happens. Only a status that is
neither 200 nor 404 fails the job, so a rate limit cannot put a wrong list in front of the approver.

npm attaches a trusted publisher to a package that already exists, and has no equivalent of PyPI's
pending publishers, so the first release of a capability has nothing to stage against.
`npm-package-existence.ts` asks the public registry which names are missing, unauthenticated and
before any credential is in play. If any are, `bootstrap-npm.ts` runs: it logs in as the service
user through npm's web flow, publishes an empty `0.0.0` under the `bootstrap` dist-tag so `latest`
is left alone, and attaches the stage-only trusted publisher. It is the one publish in the pipeline
that is not OIDC, and it takes its own approval in the `publish` environment because it waits at a
different point in the run from the staging job. Whoever holds the service-user passkey opens the
login URL from the job log and ticks npm's five-minute two-factor skip, which is why the publish and
`npm trust` calls are one process rather than one step each.

`package-registries.ts` is import-only configuration. It defines consumer-facing npm/Python index
URLs and each target's audience in one place. `publish-plan.ts` is both an importable validator and
a CLI because every npm uploader must consume the same routing decision. Public capability entries
are added to the plan only through the validated publication graph shared with
`registry/publication-check.ts`; the public descriptor is likewise filtered during construction,
while unapproved shared packages remain internal. `stage-npm.ts`
consumes only the typed public target, uses npm's OIDC trusted-publisher session, and stages rather
than directly publishing every tarball in that plan. `execute-npm-plan.ts` shares only the plan
iteration, command execution, counters, duplicate handling, and failure aggregation with the
internal publisher; each entry point owns its command and registry-specific duplicate classifier.
Execution runs independent packages with bounded concurrency in dependency-ordered waves, so a
package never becomes visible before its same-release dependencies and a large wave cannot burst
unbounded requests at a registry.

`public-python-artifacts.ts` is an import-only output helper used by `build-python.ts`. It always
materializes `dist/py/` as the complete internal set and `dist/py-public/` as the strict subset owned
by capabilities whose manifests declare `metadata.public === true`. Public publishing never falls
back to `dist/py/`; an absent or empty public directory is an empty PyPI upload set.

Only `core` and `registry` can vary by package index. `core` embeds the generated app's
package-index configuration and is currently emitted only for internal indexes because its
manifest is private; `registry` tells the CLI where packages can be downloaded and is emitted for
every index. Every other npm tarball is built once, uploaded byte-for-byte to both internal indexes,
and also routed to the public index only when its capability is public.

The build/upload split is a security boundary. A release candidate builds pull-request-controlled
npm lifecycle and PEP 517 code in a job with no secrets. Credential-bearing jobs check out trusted
workflow code and upload only the previously built artifact.

### `release/rc/`

Release-candidate policy is split along workflow boundaries:

```text
gate.ts -> version.ts -> shared publish workflow -> announce.ts
```

- `gate.ts` reads workflow results and decides whether a same-repository PR commit may publish.
- `version.ts` creates one npm- and PEP-440-compatible version from the release base and commit SHA.
- `announce.ts` creates or updates the PR's single candidate-installation comment.
- `github-rest.ts` is their import-only, schema-checked GitHub API client.

The gate and announcement stay outside workflow shell strings so their policy is typed and covered
by `tests/registry/release/rc-gate.test.ts` and `tests/registry/release/rc-version.test.ts`.

### `e2e/`

`generate_app.py` remains the only public harness entry point. Its modules divide the checks by
what they exercise:

- `e2e_harness.py`: subprocess execution, registry environment, result collection, and exit codes.
- `package_transport.py`: local artifact packing, npm acquisition, and package-versus-git output
  comparison.
- `generated_app_checks.py`: minimal-selection checks and package-only Python test suites.
- `runtime_checks.py`: Docker image builds, Helm validation, and optional live boot/health checks.
- `local_npm_registry.py`: import-only loopback npm server backed by the tarballs from `pack-all.ts`.
- `ensure_cli.py`: CI entry point that installs the public, checksum-verified Mistral CLI.
- `capability-package-py-suites.json`: the expected package-only Python suites. A registry test pins
  this floor to the suites on disk so one cannot silently disappear from the E2E.

The harness uses standard-library Python so it can run before repository dependencies are installed.
Its exit codes are `0` for success, `1` for a deterministic failure, and `75` for an unavailable CLI,
network, registry, or credential. CI treats all non-zero values as a failed required check.

Useful modes:

```sh
bun run e2e                         # package + git acquisition, builds and tests
bun run e2e -- --docker            # also build all four container images
bun run e2e -- --boot              # also boot the stack and check /api/health
bun run e2e -- --package-only      # stop after npm-package acquisition
bun run e2e -- --keep              # retain the generated app for inspection
```

The git transport reads the committed branch. The harness therefore rejects a dirty working tree by
default; commit first, or use `--allow-dirty` only when deliberately testing the package-transport
copy of local changes.
