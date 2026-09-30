# AGENTS.md

`mistralai-capabilities` — a MistralApps **capability registry**. It publishes
`@mistralai-capabilities/<kind>-<capability-id>` packages to Gemfury **and** Cloudsmith
from one build. The repo-root `registry.json` IS the descriptor the
`mistral apps` CLI reads to vendor capabilities into apps. Its
`sources.{ts,py,rs,git}` declare where each language's packages live (bare URLs;
auth is ambient).

`packages/registry` publishes that same descriptor as
`@mistralai-capabilities/registry`. It is NOT a second source of truth: the
payload is written in from the repo root by `scripts/release/pack-all.ts` at release
time and is git-ignored, so it cannot drift. It exists because the CLI's remote
(`url`) acquisition can only read a descriptor two ways — a plain HTTPS fetch,
which carries no credentials and so cannot serve a private registry, or
`bun add <package>` — and this repo is private. Without it, package-mode
`init` has no way to learn which capabilities exist.

`sources.{ts,py}` is the one descriptor field that cannot be a single committed
value: it names the index a consumer installs FROM, which differs per index. It
is inflated per index at pack time from `scripts/release/package-registries.ts`, one
descriptor tarball each, and the committed root value is the default
(Cloudsmith — the channel customers install from; Gemfury is the internal alternative).

Templates carry the same problem in static projections: `core`'s `[install.scopes]` table closing
`bunfig.toml` (the app's own `@mistralai-capabilities` scope only), its `mistralai` uv index in
`pyproject.toml` and the corresponding Basic-auth username in `tools/uv.sh`, and
`mistral-design-system`'s `.npmrc.hbs` carrier and `.npmrc.example`, which map the private
`@mistralai` / `@mistral` npm scopes. The CLI copies these out of whichever tarball it installed and
never revisits them, so every capability declaring `metadata.registryPins` is a carrier, and lists there
the exact template files to project:
`scripts/registry/app-registry-pins.ts` writes the Cloudsmith default into its committed template
and `pack-all.ts` re-writes it per index of its audience. `publish-plan.ts` routes every per-index
variant and refuses either an audience sibling gap or an explicitly required variant gap. `core` is
public, so it maps no private scope and ships no `.npmrc`: an app has one of each file, and the CLI
fails `init` with a vendor conflict when two capabilities render different bytes to one path. Its
scope table stays last because the CLI appends its own `@mistralai-capabilities` entry when it
installs capability packages; in package mode it wrote one before vendoring core, whose copy of the
file replaces it. The CLI copies plain template files before its first `bun install` but renders
`.hbs` files only after it, so a template workspace member with a private dependency ships as
`package.json.hbs`, which lands with `.npmrc`.

## Commands

- `bun install`
- `bun run lint` / `bun run format:check` / `bun run check-types` / `bun run test`
- `bun run registry:build` — regenerate the repo-root `registry.json` from
  `registry.config.json` + the `capabilities/*/capability.json` scan after changing any
  `capability.json`, and each registry-pin carrier's committed app pins from
  `DEFAULT_PACKAGE_REGISTRY` in `scripts/release/package-registries.ts`. Commit the result. `bun run registry:check` (run in
  `framework-check.yaml`) enforces public capability eligibility and fails when a committed
  descriptor or pin is stale, so CI catches both invalid publication metadata/closure and a
  forgotten regeneration. Adding an index to `PACKAGE_REGISTRIES` automatically packs a
  descriptor variant for it. `core` is public and is packed as both an anonymous public-index
  variant and authenticated internal per-index variants; `mistral-design-system` is private and is
  packed per internal index only.
  `scripts/build-registry.ts` is the descriptor builder: a repo-local mirror of the reviewed
  `mistral apps registry build` v3 emitter, byte-for-byte, run in-repo because the CLI's
  nested-root v3 builder is not yet released. It is the single canonical projection — registry-local
  code adds only domain-specific invariant checks (taxonomy, path-kind-ID alignment, destination
  ownership) on top of it, never a second descriptor shape. When the CLI ships that contract,
  `registry:build` delegates to `mistral apps registry build` with no change to the committed output.

## Tests

Two tiers, split by whether a check needs an app to exist.

`bun run test` (`tests/registry/`) asserts what is true of the repo alone — the descriptor matches
`capabilities/`, the dependency graph is acyclic, no two capabilities write the same path into an
app, no `__TOKEN__` sentinel is reintroduced, no `.hbs` contains Helm `{{ }}`. Runs in CI on every
PR. See `tests/registry/README.md` for the suite layout and its three maintenance generators.

`bun run e2e` generates an app with every declared capability and checks what the CLI actually
produced: substitutions fired, nothing unrendered, both workspaces install, lint/format/types/tests
pass on each half, the chart lints and renders. ~2 minutes. It **refuses a dirty tree** — the CLI
vendors the committed branch, so a dirty run would grade code it never saw. Local commits are
enough; no push needed. Exit 75 means the environment failed (no CLI, no network, no token), not
the registry.

`bun run e2e -- --docker` adds the four container image builds. That is the only check that proves
the deps-stage `COPY` globs still match anything, but it costs ~15 minutes cold (the web image
dominates), so it is opt-in and prints a SKIP line when omitted rather than passing silently. Run
it when you touch `deploy/docker/`, the workspace layout, or a `package/` zone.

CI runs the e2e on every PR (`generated-app-e2e.yaml`). It obtains the CLI from the public
`mistralai/cli` release through `install.sh`, checksum-verified and with no credential, so fork
PRs get the same coverage. The generated app pins the default index, so the run authenticates its
private dependencies with the `CLOUDSMITH_ENTITLEMENT_TOKEN` repository secret; locally, export an
entitlement token as `MISTRAL_REGISTRY_TOKEN` and `NODE_AUTH_TOKEN`. The run takes 15-20 minutes, against ~2 minutes locally. **Run it
locally before pushing a template change** rather than waiting on CI to find it.

## The capabilities are the source of truth

Each capability's `template/` and `package/` zone is **hand-maintained here**. Edit the files in
`capabilities/<kind>/<id>/` directly.

They were originally generated once, by partitioning a source app into ten capabilities. That
pipeline — the ownership manifest, the per-capability split transforms and the template-fidelity
verifier — has been removed along with the dependency on the app, so there is no regeneration step
and nothing overwrites a hand edit. If you need the history, it is in the git log up to the
`chore(scripts): drop the source-app generation pipeline` commit.

The only remaining generator is the descriptor: run `bun run registry:build` (the repo-local mirror
of `mistral apps registry build`, see Commands) after changing a `capability.json`.

## Authoring capabilities

Run `mistral apps capability init <name>` at the repo root to scaffold a new
capability under `capabilities/<kind>/<name>/` (two zones: `package/` reusable toolkit

- `template/` the distributed template). Load the **write-mistral-apps-capability**
  skill before building one out.

Author canonical `template/`, `package/`, and `INSTALL.md` content for every audience, even when a
capability is internal-only today. Keep internal hosts, credentials, private service names, and
internal-only assumptions out of shared content. If an audience genuinely needs different content,
make the exception explicit and reviewable in capability-owned files (for example, a
`metadata.registryPins`-projected file or a guarded template), rather than relying on hidden
release-time redactions. Check packed artifacts as well as source; audience-neutral content alone
does not make a capability public without its publication metadata and policy checks.

There is one canonical `template/**` per capability -- no per-audience overlay directory. Core's
generated-app `package.json` and `bunfig.toml` (like its `pyproject.toml`, `gitignore`, and
`tools/uv.sh`) are `metadata.registryPins` carriers: `scripts/registry/app-registry-pins.ts` projects
each from the single committed canonical file per package index, rather than substituting a
separately maintained public copy. For `package.json`, an authenticated index gets the canonical
bytes back unchanged; the anonymous public index gets a minimal-diff re-serialization, in the file's
own key order, that removes unreviewed `@mistral/*` / `@mistralai/*` entries from
`overrides`/`resolutions` and any `//` comment naming them, preserving every workspace glob, the
catalog, every script (`dev:web` included), every real dependency, and `packageManager`. Exact
public names reviewed in `scripts/registry/public-mistral-npm.ts` are exempt from this scope rule
and included in the public npm dependency allowlist; scope alone does not establish privacy. It
fails closed -- refusing to pack -- on an unreviewed Mistral-scoped name in a real dependency or the
workspace catalog (that is a dependency the app actually installs, not something to silently drop),
on a JSON shape the projector was not reviewed for, or on an unreviewed scope mention still present
in its serialized output. `bunfig.toml`'s anonymous projection drops today's reviewed private names
from `minimumReleaseAgeExcludes` but preserves exempt public names. The release-owned package-root
npm `files` allowlist (`scripts/release/public-core-package.ts`, covering the `@mistralai-capabilities/core` PACKAGE
artifact's own tarball membership) a distinct concern from the app-template registry pin: do not
conflate what ships inside the npm package with what a generated app's own config files contain.

## Web composition

The generated web app (`apps/web`, owned by `tanstack-start`) is composed **by adding files**, using
the frameworks' own extension points. The shell names no capability and ships no `.hbs`; no
capability edits another's file.

| To add                                                                            | Add this file                                                                                                                                            | Discovered by                                           |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| A page                                                                            | `apps/web/src/routes/<path>.tsx` (`routes/_app/<path>.tsx` inside the design-system shell)                                                               | TanStack Router file routes                             |
| Page metadata                                                                     | `staticData` on the route: `landing` (`/` redirects to the strongest claim), `nav` / `sidebar` (design-system shell)                                     | the route tree (`router.routesById`)                    |
| A Vite / Nitro build concern (plugins, proxy, SSR, aliases, stylesheet injection) | `apps/web/vite-plugins/<capability>.ts`, default-exporting a Vite `Plugin` (use `config()` to change settings)                                           | `vite.config.ts` loads the directory, filename order    |
| An Nx target for the web app                                                      | an Nx project of your own (e.g. in `packages/ts/<capability>/`)                                                                                          | the workspace `check` runs every project's              |
| A chat side app                                                                   | `apps/web/src/routes/_app/chat/<app>.tsx` with `staticData.chatApp: { label, icon, tools?, fullscreen? }`; read the conversation with `useChatContext()` | chat's layout route: its child routes                   |
| A chat API extension (dictation, read-aloud, …)                                   | `apps/web/src/features/chat/extensions/<capability>.ts`, default-exporting a `ChatExtension` (`transcribeAudio?`, `synthesizeSpeech?`)                   | `features/chat/extensions.ts` (Vite `import.meta.glob`) |

A file that only makes sense with another capability present means a dependency on it (speech plugs
into chat, so speech depends on chat), or a hidden derived capability when both sides are optional
(`fastapi-tanstack-start`). Tests never rely on discovery: they build their own route tree or pass
their own extensions (`ChatApiProvider`).

## Before an app can be generated

A registry needs a shell: exactly one capability marked `"required": true` in its
`capability.json`, shipping the app's root `package.json` in its `template/`.
Here that is `core`, and it is the ONLY required capability. Required capabilities
are always installed (shown-but-locked in the picker); mark recommended-but-optional
capabilities `"default": true` so they are pre-checked but deselectable.

A capability may instead declare `"activatedWhen": { "allOf": [<refs>] }` to become **derived**:
it is not installed on its own but activates automatically once every referenced capability is
effective, and selecting it directly installs those references as its prerequisites. The references
use the same grammar as `dependencies` (bare `id`, `kind/id`, or `registry/kind/id`) and must be
non-empty, unique, and free of self-reference or activation cycles; a derived capability is never an
ordinary `dependencies` target and never repeats a prerequisite under `dependencies`. `visible`
defaults to true — set `"visible": false` to keep a capability (typically a hidden integration
derived capability) out of discovery and the picker while it stays directly selectable by id and
shown in installed state, status, and plans. Both fields serialize into the current descriptor
version, so adding them is not a version bump; `build-registry.ts` qualifies and validates them.

The app modules — `fastapi` (`apps/api`), `tanstack-start` (`apps/web`) and `workflows`
(`apps/worker`) — are optional, not required: a capability that needs one declares
it in `dependencies` and the CLI pulls it in transitively. `fastapi`, `tanstack-start`, and
`workflows` are `"default": true`, so a default app contains the API, web app, and worker.
Deselecting a module has to leave a workspace that still resolves, so **nothing in `core`'s
`template/` may name an optional module by a literal path in a list the tooling refuses to start
without**. The root manifests are static: optional tooling contributes standalone configuration and
dependency-only workspaces under `packages/{ts,py}/<capability>`, which the existing globs discover
only when selected. Dependencies used only by an optional generated app belong in that app's
capability-owned package template with concrete versions, not in `core`'s root catalog.
`package.json` `workspaces.packages` uses `apps/*` and `packages/ts/*`, while
`[tool.uv.workspace] members` uses `apps/*` and `packages/py/*`; both tolerate an absent optional
workspace. `[tool.ty.environment]` lives with `code-quality` and names only the three packages core
itself ships, so it holds for every composition; the quality task discovers optional Python roots
from the workspace layout and existence-filters them. The root `package.json` may not devDepend on a
member an optional capability ships, since bun hard-errors on an unresolvable `workspace:*`; an
`overrides` entry for one is fine, being inert until something actually depends on it.
The `.mistral/repositories/…` capability paths are exempt — the CLI vendors the
whole registry subtree regardless of selection, so those never dangle.

Every capability root is **nested** under its kind directory at
`capabilities/<kind>/<id>`. `scripts/shared/manifests.ts` walks recursively (never
descending into a directory that already holds a `capability.json`) and enforces
the registry-local topology invariant during discovery — a root must live at
exactly `<kind>/<id>` (matching its manifest `kind`), rejecting a shallow,
over-nested, or mis-grouped location. `build-registry.ts` derives each entry's
`<kind>/<id>` location from its `kind` and `id`; the v3 descriptor does not
persist a per-capability `path`. Because every root sits at exactly
that depth and its template zone one level deeper
(`capabilities/<kind>/<id>/template/`), `workspaces.packages` and
`[tool.uv.workspace] members` use the `capabilities/*/*` glob: it matches every
root and no template zone — a template ships the GENERATED app's
`package.json`/`nx.json`, which a wider glob would let turbo load as a package
of this repo.

The same "must survive a deselection" rule governs dependency edges, and there it
binds every capability, not just `core`: **no `template/` `package.json` may declare
an `@mistralai-capabilities/*` dependency.** The CLI owns those edges — it runs
`bun add` at the app root for the selected set, and rewrites any capability entry a
module manifest already carries to the vendored `file:` path. A hardcoded one is
therefore redundant when that capability is selected and fatal when it is not:
`mistral apps init --caps web` died on `Workspace dependency
"@mistralai-capabilities/feature-chat" not found` while `apps/web` named `chat` and `speech`
unconditionally. Declare the edge in `capability.json`'s `dependencies` instead; the
package resolves from the app root either way. A `.hbs` manifest may name one behind
a `{{#if (has "<id>")}}` guard — that is how the Python manifests do it —
and `tests/registry/` enforces the JSON half.

Author capability templates against the app-local
`@/*` / `@app/*` aliases directly (vendoring is a pure copy). Until you author the
shell, `mistral apps init` against this registry has no shell to vendor.

## Releasing

Push a `vX.Y.Z` tag. `.github/workflows/publish.yaml` resolves the version and
hands it to `publish-core.yaml`, the shared pipeline, which builds every
artifact once and publishes it to **both** Gemfury and Cloudsmith, then cuts a
GitHub release only if both succeeded.

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The public npmjs.org/PyPI proof-of-concept leg is separate and stays off on tag
pushes. It can run only from a manual **Publish** dispatch, run from `main`, with
`target: public`, for an existing `vX.Y.Z` tag when `public_publish_confirmation`
exactly equals `STAGE_NPM_AND_PUBLISH_PYPI`. The `version` input is required, because a
dispatch runs from `main` and an omitted version could only be read off
whichever tag happened to be newest. The workflow resolves the requested
version back to that tag before building, and refuses one that is behind the
newest release tag. Both public jobs use OIDC without registry-token
secrets and target the `publish` GitHub Environment; repository administrators
must configure required reviewers, prevent self-review, and a deployment branch
policy limiting the environment to `main`. That policy is why the dispatch runs
from `main` rather than from the tag: the dispatched ref decides which copy of
the workflow executes, and the version job resolves the tag regardless. The
manual dispatch defaults to `target: internal` for Gemfury/Cloudsmith retries;
`target: public` skips those internal jobs. Each public upload crosses its own
protected-environment approval. PyPI uploads first: a
project name belongs to whoever uploads to it first, and the npm bootstrap makes
a new capability's name public as soon as it publishes the skeleton. npm
artifacts are staged rather than published, so they remain unavailable until
separately approved on npmjs.org. Trusted Publisher registration must name the
caller `.github/workflows/publish.yaml` (and its `publish` environment), because
the OIDC `workflow_ref` claim identifies the caller rather than reusable
`publish-core.yaml`. Python is built once into two canonical sets:
`dist/py/` always retains every Python distribution for the internal indexes,
while `dist/py-public/` contains only capabilities whose manifest declares
`metadata.public === true`. The PyPI job consumes only `dist/py-public/`.

- **Released versions are plain `X.Y.Z`.** One string is stamped into both
  `package.json` and `pyproject.toml`. A pre-release tag is rejected outright:
  a candidate is named for a commit and published per-PR by `publish-rc.yaml`,
  which derives its own version; a tag that is not a release should not go
  halfway through the release pipeline. See below.
- **Gemfury** authenticates with the `GEMFURY_UPLOAD_TOKEN` repo secret
  (Gemfury has no trusted publishing). Its DEPLOY token is read-only and cannot
  push; only its UPLOAD token is the write credential. **Cloudsmith** uses OIDC
  and stores no credential; its service account is provisioned in `iac-solutions`
  (`cloudsmith/config/cloudsmith_publishers.yaml`).
- Re-running the newest release is safe: npm versions already on a registry are
  skipped, and `uv publish --check-url` no-ops an already-published dist. An
  older version cannot be re-run once a newer tag exists.
- **The Apache-2.0 grant follows `metadata.public`.** A public capability and the
  descriptor package declare `"license": "Apache-2.0"` (npm) and `license` plus
  `license-files = ["LICENSE"]` (Python). A private capability declares
  `"license": "UNLICENSED"` and `license = "LicenseRef-Proprietary"` with no
  `license-files`, because it only ever reaches consumers who already hold a
  separate agreement. `scripts/release/licensing.ts` is the one selector; both
  prepare scripts fail the release on a manifest that disagrees with it.
- **The licence text lives once, at the repository root.** No package carries the
  text: `prepare-publish.ts`, `prepare-publish-python.ts` and `pack-all.ts` copy
  the root `LICENSE` into the public packages at build time. Do not add a tracked
  copy to a package directory. `uv_build` skips a `license-files` glob that
  matches nothing rather than failing, so `public-artifacts:check` asserts the
  packed member instead, comparing its bytes against the root `LICENSE`.
- **A `public-artifacts` job gates the first public upload.** It downloads the
  `dist` artifact the publish jobs consume and runs
  `public-artifacts:check --prebuilt` over it with `contents: read`, no
  environment and no secret; both `publish-pypi` and `publish-npmjs` need it. It scans the upload rather
  than rebuilding, because the build is not reproducible and a clean second build
  says nothing about the bytes that reach npmjs and PyPI. Its checkout is
  `inputs.ref`, not `publisher_ref`, because the manifests deciding which
  artifacts are public must be the ones the artifact was built from.
- **Adding a registry for an existing audience** is one entry in
  `scripts/release/package-registries.ts` plus a publish job for it. A new audience
  must also be enforced by the npm and Python builders when they construct that
  target's output set: the fail-closed `public-artifacts:check` job
  intentionally fails `Framework check` (and therefore blocks RC publication) if a
  public plan or build contains a non-public capability. The packed-artifact gate derives private
  capability and package identities from manifests and private source bindings, checks descriptor
  and capability reference closure, and scans archive names and contents. Generic bare ids are
  rejected only in capability contexts; qualified ids and package identities are always rejected.
  Core's anonymous variant is staged with an explicit package-root file allowlist
  (`scripts/release/public-core-package.ts`) and its `package.json`/`bunfig.toml` app-template pins
  projected for the anonymous index by `scripts/registry/app-registry-pins.ts`; the canonical
  template, including `packages/py/utils/src/utils/logging.py`, remains the single source for every
  audience's variant -- there is no separate public overlay file. The publish job never globs
  for npm tarballs: it asks `scripts/release/publish-plan.ts <id>` (or passes the id
  to `publish-npm.ts`) for its upload set, so each per-index variant is routed by the
  same code that packed it. A plan missing a variant another index has is a hard
  error in `planFor`, not a shorter upload — that combination would leave the index
  serving a stale descriptor, or shipping no `core` at all, with nothing in the
  release failing.

The pipeline is `prepare-publish*` (stamp) → `pack-all` / `build-python`
(artifacts into `dist/`) → `publish-npm` per registry. `build-python` never
filters the internal output by registry target: `dist/py/` is complete and its
public-eligible subset is copied to `dist/py-public/`. Publishing is separated
from building so both internal registries serve byte-identical files — except
the variant packages: `registry` (packed for every index because of the
descriptor's `sources`), `core` (packed as a public variant and as internal
per-index variants because of the app's uv index pins), and `mistral-design-system`
(packed per internal index because of the app's `.npmrc`).

## Release candidates

Every pull request whose checks all go green publishes a candidate of every
capability, named for its head commit and targeting the next patch after the
last release tag, and says so in a comment on the pull request:

```bash
mistral apps capability update 0.1.3-rc52309221   # bump a generated app to it
bun add @mistralai-capabilities/feature-chat@0.1.3-rc52309221
uv add mistralai-capabilities-feature-chat==0.1.3-rc52309221
```

- **One comment per pull request, not one per commit.** The announcement is
  rewritten in place on every green commit — found again by an invisible
  `<!-- mistralai-capabilities:rc -->` marker — because only the newest
  candidate is the one worth installing, and twenty of them would bury the
  review. It is posted with `GITHUB_TOKEN` (`pull-requests: write`), so it
  triggers no further workflow. Two candidates can be in flight at once, so the
  `announce` job takes a concurrency lock on the pull request and
  `rc-announce.ts` re-reads the head immediately before writing, stopping unless
  the head is still its own commit. Both halves are needed: the read and the
  write are two operations, and the lock is what stops a newer announcement
  landing between them and being overwritten by a slower older one.
- **The workflow decides nothing.** Whether a commit has earned a candidate ends
  with pull-request code being built next to publish credentials, so that policy
  is `scripts/release/rc/gate.ts` — typed, and tested in
  `tests/registry/release/rc-gate.test.ts`
  against every way it could wrongly say yes — not a script pasted into a YAML
  string. `publish-rc.yaml` gathers facts and wires outputs. Same for
  `rc-announce.ts` and `rc-version.ts`; `github-rest.ts` is the shared REST
  surface, which reads every response field by field rather than trusting a
  shape.
- **One version string, everywhere.** `scripts/release/rc/version.ts` renders it and is
  the only place it is spelled. `0.1.3-rc52309221` is legal npm semver AND legal
  PEP 440 — PEP 440 allows the `-` before a pre-release segment — so one string
  reaches both package managers and, more to the point, the CLI:
  `mistral apps capability update [<id>] [<version>]` takes a SINGLE positional
  version and rewrites every `@mistralai-capabilities/*` specifier in a
  generated app from it. Two spellings left that command with no argument to
  take. It reads a positional as a version only when it matches
  `/^\d|^v\d|^\^|^latest$/`, which a candidate always does; `rc-version.test.ts`
  asserts that. The sha rides in base ten because PEP 440 requires an INTEGER
  after `rc`; the hex sha would only fit PEP 440's local segment (`+31e2ce5`),
  and npm semver ignores build metadata when comparing, so every commit of a PR
  would look like one already-published version to the registry. Recover the
  short sha with `printf '%07x' 52309221`; the announcement prints the full one
  anyway.
- **The Python index lists `0.1.3rc52309221`.** PEP 440 normalisation drops the
  separator. It is the same version — a pin of the un-normalised string matches
  it — and the announcement says so, because otherwise it reads like a broken
  publish. `pythonIndexVersion` in `rc-version.ts` is that spelling.
- **Pin the exact version.** Candidates publish under the `rc` npm dist-tag and
  a PEP 440 pre-release is invisible to a plain `uv add`, so neither shows up by
  accident — and neither is discoverable without the full string.
  Within a candidate, sibling `@mistralai-capabilities/*` deps are pinned
  exactly rather than with a caret, so an RC tree cannot resolve half of itself
  to a release.
- **`.github/workflows/publish-rc.yaml` waits on the checks, it does not run
  them.** One workflow cannot `needs:` a job in another, so it wakes on the
  completion of `Framework check` or `Generated-app e2e` and asks the API
  whether every run for that commit is finished and green. Two consequences:
  `workflow_run` only fires for a file already on `main`, so a change to this
  workflow cannot be exercised on its own PR (use its `workflow_dispatch` input
  after merging), and fork pull requests never publish, because that job holds
  the publish credentials.
- **The build job never sees a secret.** It compiles pull-request code — npm
  lifecycle scripts, PEP 517 backends — so the credentials live only in the
  upload jobs, which take their scripts from the default branch.
- Candidates accumulate. Neither index prunes them; pruning is a repository
  policy, not something this pipeline does.
