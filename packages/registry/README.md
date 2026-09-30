# `@mistralai-capabilities/registry`

The **descriptor package**. It ships exactly one payload file — the repo-root
`registry.json` — so that `mistral apps` can bootstrap this registry from a
package index (Cloudsmith / Gemfury) instead of a git checkout.

## Why this package exists

The CLI has two ways to obtain a registry descriptor for a `url` acquisition
(`RemoteResolver.bootstrap`):

1. **fetch** — plain HTTPS `GET` of a `registry.json`. Unusable here: the fetch
   carries no credentials by design (a token in the URL is rejected up front),
   so it only works for a publicly readable descriptor.
2. **npm package** — `bun add <package>` into a temp dir, then read
   `registry.json` from `node_modules/<package>/`. Auth is ambient, from the
   app's `bunfig.toml` / `.npmrc`.

This repo is private, so (2) is the supported path — and this is that package.
The capability packages themselves are published to both Gemfury and Cloudsmith;
without a descriptor alongside them the CLI had no way to learn _which_
capabilities exist, so package-mode installs could not start at all.

## Consuming it

```bash
mistral apps init my-app \
  --source npm \
  --registry-url=https://npm.cloudsmith.io/mistral-ai/sdk-distribution/ \
  --registry-package=@mistralai-capabilities/registry \
  --scope=@mistralai-capabilities
```

Cloudsmith is the default index. Swap `--registry-url` for the Gemfury index
(`https://npm-proxy.fury.io/mistralai/`) and the rest is unchanged — see below
for why the descriptor you get back differs.

The CLI installs this package with `--ignore-scripts` and reads the descriptor
straight off disk, which is why the package ships data only: no entry point, no
dependencies, no install hooks.

It is installed **unpinned**, so a consumer always resolves the latest published
descriptor rather than a version-keyed cache entry.

## One variant per index

The descriptor's `sources.{ts,py}` name the registry a consumer installs the
capability packages from. That is a property of the index serving the
descriptor, not of the release: a descriptor pulled from Cloudsmith that sends
its installs to Gemfury points the consumer at a host it has no credential for,
and `bun add` dies on a bare 401.

So this package is packed once per entry in `scripts/release/package-registries.ts`,
each variant carrying that index's URLs and tagged in the publish plan with the
index it belongs to. Every publish step resolves its upload set through
`scripts/release/publish-plan.ts` rather than globbing, so a variant can neither be
cross-published nor silently left behind.

`@mistralai-capabilities/core` also needs a separate variant for each index where
it is eligible: its template carries the app's `.npmrc` scope registries and the
`mistralai` uv index URL, which `sources` does not reach. It is currently private,
so only internal variants are built. Those two packages aside, every tarball in
the release is shared byte-for-byte.

## `registry.json` is generated, not committed

The payload is written here by `scripts/release/pack-all.ts` at release time — once per
index, as above — and is git-ignored. Committing a copy would let it drift from
the authoritative root descriptor, which CI already guards with
`mistral apps registry build --check`, and would force one registry's URLs on
every consumer.

A consequence: `npm pack` in this directory produces an empty package unless
`pack-all.ts` has run first. That is the same contract every other package in
this repo follows — the release pipeline is
`prepare-publish*` → `pack-all` / `build-python` → `publish-npm`.
