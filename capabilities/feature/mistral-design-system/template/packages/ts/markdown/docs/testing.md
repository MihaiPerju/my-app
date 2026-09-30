# Testing

`@mistral/markdown` is tested in layers. Each layer catches a different class of bug.

## Type and build checks

Commands:

- `pnpm --filter @mistral/markdown build`
- `pnpm fix` from the `ts/` root

These checks catch TypeScript, lint, and formatting regressions. `pnpm fix` is required before finishing changes in this monorepo.

## Unit and regression tests

Command:

- `pnpm --filter @mistral/markdown test:ci`

Vitest covers parser behavior that is easier to express as focused examples than as full spec corpus cases. It also runs the committed CommonMark and GFM corpus files so CI catches spec regressions without a local `.scratch/` checkout.

Main files:

- `tests/parse.test.ts`
  - block and inline parsing examples
- `tests/session.test.ts`
  - append-only sessions, finalization, optimistic projection, structural sharing
- `tests/incremental-state.test.ts`
  - dirty-window and parser-state regressions
- `tests/state.test.ts`
  - source append and line-cache behavior
- `tests/gfm-regressions.test.ts`
  - focused GFM cases not worth hiding in the full corpus
- `tests/math-compat.test.ts`
  - Le Chat math delimiters, money-vs-math ambiguity, dropped bare-TeX behavior
- `tests/smoothing.test.ts`
  - React-store typewriter smoothing, subscription behavior, reset behavior, finalized no-animation paths
- `tests/transforms.test.ts`
  - `unstable_transforms` projection semantics and structural sharing constraints
- `tests/spec-harness/official-corpus.test.ts`
  - committed CommonMark and GFM corpus compliance

## Official spec suites

Commands:

- `pnpm --filter @mistral/markdown spec:commonmark`
- `pnpm --filter @mistral/markdown spec:gfm`
- `pnpm --filter @mistral/markdown spec:gfm-full`

These run the committed official CommonMark and GFM corpora through the custom harness. The parser is AST-first, so the harness uses an adapter to compare against the HTML expected by the upstream specs.

The parser has one Mistral dialect. Dialect conflicts are recorded as harness skips, not parser modes.

Harness details are in `docs/spec-harness.md`.

## Real-world corpus

Command:

- included in `pnpm --filter @mistral/markdown test:ci`

`tests/real-world-corpus.test.ts` uses sanitized Le Chat production messages from `tests/fixtures/real-world-messages.ts`.

It checks:

- final AST parity between one-shot and incremental parsing
- real message shapes that are easy to miss in small synthetic tests
- stable behavior for the fixture set used by parser benchmarks

Corpus background is in `docs/real-world-corpus.md`.

## Incremental parity

Incremental parsing has a stricter bar than “does the streaming UI look right”.

For finalized input, session output must match one-shot output for the same source. That invariant is checked by focused session tests and by the real-world corpus.

This catches bugs where a streaming split leaves stale parser caches behind or finalization depends on chunk boundaries.

## Optimistic streaming coverage

Optimistic projection is intentionally different before finalization. Tests should lock visual stability decisions, not just parser permissiveness. Examples:

- unfinished emphasis can render as emphasis while streaming
- partial tables can be suppressed until the table is structurally clear
- explicit links can stay link-shaped while their destination closer is still streaming
- ambiguous tails should be suppressed until more input arrives

The expected temporary behavior is covered in `tests/session.test.ts`. Finalized parity tests still require the final AST to match one-shot parsing.

`tests/optimistic-audit.test.ts` is a broader no-flash guard. It replays a representative streaming message with variable chunks and every char cut, renders the projected AST to visible text, and fails on suspicious raw tails such as dangling delimiters, partial list/table markers, and unresolved dollar tails.

## Benchmarks

Commands:

- `pnpm --filter @mistral/markdown bench:node`
- `pnpm --filter @mistral/markdown bench:hermes`
- `pnpm --filter @mistral/markdown bench:all`
- `pnpm --filter @mistral/markdown bench:memory`
- `pnpm --filter @mistral/markdown bench:compare <before-log-or-json> <after-log-or-json>`

The main benchmark corpus lives in `scripts/benchmark-fixtures.ts`.

Full-parse cases:

- short assistant reply
- long prose answer
- structured answer
- math and prices answer
- working steps list-heavy answer
- real-world assistant corpus

Streaming cases:

- burst streams
- character-by-character typewriter reveal
- open code fence
- late link tail
- late paragraph continuation
- late literal autolink tail
- math and prices stream
- working steps list-heavy token stream
- real-world table-heavy token stream
- real-world HTML code token stream
- real-world math/HTML token stream
- real-world mixed token stream

The Node benchmark runner compares against JavaScript baselines such as remark, micromark, markdown-it, marked, and commonmark.js where the comparison is meaningful. It also includes `cmark-gfm native html` as an optional native GFM/HTML baseline when the local native binding is available. The Hermes runner stays JavaScript-only.

`bench:compare` summarizes before/after benchmark logs with two headline scores: real-world streaming and full parse. It also reports the worst case and any regressions above 5%.

Benchmark interpretation and checked-in numbers live in `docs/perf-report.md`.

## Transform benchmarks

Transform overhead is measured separately from the main parser cases.

Source:

- `scripts/benchmark-transform-cases.ts`

Variants:

- no transforms
- no-op transform
- synthetic custom projection transform
- Le Chat transforms

These benchmarks protect the no-transform hot path and make product transform cost visible.

## What this package does not test

This package does not test:

- HTML rendering correctness
- React or React Native renderer output
- Le Chat message preprocessing outside the transform fixtures
- user-visible app performance
- arbitrary middle-of-document editing
- public parser-state serialization

Those belong in renderer, app, or integration test suites.
