# AGENTS.md

This package is the home of `@mistral/markdown`.

Read these files first:

- `README.md`
  - current public API and package contract
- `docs/requirements.md`
  - product and technical requirements
- `docs/architecture.md`
  - parser boundaries, data ownership, session model, and projection pipeline
- `docs/incremental-parsing.md`
  - parser-internal dirty-window and append-safety notes
- `docs/spec-harness.md`
  - official CommonMark/GFM harness sources, statuses, and adapter boundary
- `docs/testing.md`
  - test suites, benchmarks, and what each layer catches
- `docs/math-cleanup.md`
  - math scope, Le Chat compatibility target, and dropped bare-TeX delimiters
- `docs/prior-art.md`
  - prior-art research and baseline parsers to compare against
- `docs/perf-report.md`
  - checked-in benchmark numbers and interpretation
- `docs/real-world-corpus.md`
  - sanitized production-message corpus, legacy mdast comparison, and known gaps
- `docs/todo.md`
  - active follow-up work

Key principles:

- keep the public API minimal
- do not add config options unless they are absolutely necessary
- stay framework-agnostic
- make the session API fit React without adding React-specific runtime code
- parse to mdast-compatible ASTs
- support append-only incremental parsing before arbitrary edits
- preserve structural sharing for unchanged AST subtrees
- keep markdown directives out of the new core design

Key tools:

- `pnpm --filter @mistral/markdown build`
- `pnpm --filter @mistral/markdown test:ci`
- `pnpm --filter @mistral/markdown spec:commonmark`
- `pnpm --filter @mistral/markdown spec:gfm`
- `pnpm --filter @mistral/markdown spec:gfm-full`
- `pnpm fix` from the `ts/` root before finishing any task

Spec and research data:

- official CommonMark and GFM corpus text files are committed in `tests/spec-harness/corpus/`
- keep scratch clones local and gitignored
- do not commit vendored upstream repos into the package

Implementation guidance:

- prefer pure functions
- treat published snapshots as read-only; the internal session workspace may be mutable and non-serializable
- treat mdast as the public format, not necessarily the hot-path internal one
- use the custom spec harness for official corpus progress
- use Vitest for harness unit tests, parser unit tests, and focused regressions
