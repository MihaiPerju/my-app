# Spec harness

`@mistral/markdown` is AST-first, but official CommonMark and GFM corpora are HTML-based. The package uses a custom harness to run those corpora and compare through an adapter.

## Commands

- `pnpm --filter @mistral/markdown spec:commonmark`
- `pnpm --filter @mistral/markdown spec:gfm`
- `pnpm --filter @mistral/markdown spec:gfm-full`

## Sources

The harness reads committed text corpora:

- CommonMark: `tests/spec-harness/corpus/commonmark-spec.txt`
- GFM extensions: `tests/spec-harness/corpus/gfm-extensions.txt`
- full GFM: `tests/spec-harness/corpus/gfm-spec.txt`

These files are copied from the upstream CommonMark and cmark-gfm specs and keep their upstream CC-BY-SA 4.0 license metadata in the file headers. Do not commit upstream repos; update only the corpus text files when intentionally moving the compliance target.

`pnpm --filter @mistral/markdown test:ci` also runs the committed corpora through Vitest so spec compliance does not depend on a local `.scratch/` checkout in CI.

## Status model

The harness reports:

- `pass`
- `fail`
- `not_implemented`
- `error`
- `skip`

`skip` is used for deliberate dialect overlap. The parser has one Mistral dialect, so examples that intentionally reject Mistral extensions are skipped in the harness rather than hidden behind runtime parser flags.

## Adapter boundary

The official suites compare markdown input to expected HTML.

The package parses markdown to mdast. The harness adapter projects the AST to HTML for conformance checks. That projection is test infrastructure, not a public renderer.

Vitest still owns normal unit tests:

- fixture parsing
- harness aggregation
- parser regressions
- smoothing behavior
- transform behavior
