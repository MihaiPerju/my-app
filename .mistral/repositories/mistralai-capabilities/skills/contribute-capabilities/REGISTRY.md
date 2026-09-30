# The registry repo

What `mistralai-capabilities` gates on, beyond its own `AGENTS.md`.

## Template constraints

- Vendoring is a plain copy: a template file must be valid at its final app path, written against
  the app's `@/*` and `@app/*` aliases.
- `.hbs` files render with one variable, `{{projectName}}`. Files carrying Helm's `{{ }}` are not
  `.hbs`.
- Two capabilities cannot contribute the same output path. `.templateignore` lists what `template/`
  does not vendor.

## The gate

The e2e generates an app that installs from Cloudsmith. Load the credentials from
`~/.env.cloudsmith` first (`setup-mistral-apps` creates it):
`set -a; . ~/.env.cloudsmith; set +a; export MISTRAL_REGISTRY_TOKEN="$CLOUDSMITH_PASSWORD" NODE_AUTH_TOKEN="$CLOUDSMITH_PASSWORD"`.

```bash
bun run registry:build        # after any capability.json change; commit the result
bun install && bun run lint && bun run format:check && bun run check-types && bun run test
bun run registry:check
git commit … && bun run e2e   # when template/, package/ or deploy/ changed
```

Add `-- --docker` to the e2e when you touch `deploy/docker/`, the workspace layout or a `package/`
zone.

## Tests

**`bun run test`** runs `tests/registry/` on every PR. Every assertion is a pure function of
committed files: descriptor and `capabilities/` agree, the dependency graph is acyclic, one
`required` capability, package zones exist, naming conventions, template rules.

**`bun run e2e`** runs `scripts/e2e/generate_app.py`: a real `mistral apps init` with every
capability, then install, build, lint, types, tests, `helm lint` and `helm template`; `--docker` adds
the image builds. It grades the committed branch, so commit first. Exit `75` is an environment
failure (no CLI, network or token), not a verdict; `--keep` keeps the tempdir.

A new invariant that the files alone prove goes in the matching `tests/registry/*.test.ts`. One that
needs a built app becomes a `check(name, ok, detail)` in `scripts/e2e/`. Prefer the first: it runs in
milliseconds, the e2e in minutes.

## CI gates

`framework-check.yaml` runs lint, `format:check`, a check that Dockerfile `COPY` sources stay globs,
`check-types`, `bun run test`, the uv and cargo checks, and `bun run registry:check`:

1. **`publication-check.ts`** — every `capability.json` sets `metadata.public` to an explicit boolean
   (`invalid-public-flag` otherwise). Write `false` unless it ships to npmjs.org and PyPI. A public
   capability needs:
   - at least one `packages` language, and only public capabilities in its dependency closure;
   - npm dependencies that are `workspace:` / `file:`, or a name on `PUBLIC_NPM_PACKAGE_ALLOWLIST`
     with a semver, `*`, `latest` or `catalog:` specifier (never `git+ssh:`, tarball URLs or
     `npm:` aliases);
   - a `pyproject.toml` whose only index is credential-free `pypi`, and whose `[tool.uv.sources]`
     entries are `{ workspace = true }` or `{ index = "pypi" }` (`private-python-index` otherwise);
   - `(has "<id>")` template gates naming only public capabilities of this registry
     (`private-template-gate` otherwise).
2. **`build-registry.ts --check`** and **`app-registry-pins.ts --check`** — fail when `registry.json`
   or the pins drift from `capabilities/`.

`generated-app-e2e.yaml` runs the e2e on every PR.

## Versions and changelogs

Leave manifest versions as placeholders: a `vX.Y.Z` tag stamps one lockstep version on every package
and publishes. `CHANGELOG.md` is hand-edited per capability, Keep-a-Changelog, under `[Unreleased]`.
Write `### Breaking` for a reader with no context: it is what a consuming app's agent follows on
upgrade.
