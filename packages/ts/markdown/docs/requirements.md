# Requirements

This document defines the product and technical requirements for `@mistral/markdown`. The public API contract lives in `README.md`.

## Product scope

- Parse markdown into mdast-compatible ASTs.
- Optimize for Le Chat message rendering, especially append-only assistant streaming.
- Keep full-message parsing competitive with fast JavaScript markdown parsers on message-shaped documents.
- Support optimistic projection so streaming users do not see avoidable formatting flashes.
- Keep the base package framework-agnostic.

## Syntax

The parser must expose one Mistral dialect. It must not expose runtime syntax modes.

The dialect includes:

- CommonMark, parsed through the Mistral dialect
- GFM autolink literals, strikethrough, tables, task list items, and footnotes
- inline math with `$...$` and `\(...\)`
- block math with `$$...$$` and `\[...\]`
- inline HTML and HTML blocks
- custom elements written as HTML

The dialect excludes:

- markdown directives
- MDX
- bare TeX environments as markdown delimiters
- arbitrary third-party syntax plugins

HTML must be parsed as markdown syntax and preserved in the AST. The parser must not sanitize, execute, or render HTML.

## Math

Math parsing must preserve the math payload for downstream renderers.

TeX environments are valid inside supported math delimiters. Bare `\begin{equation}...\end{equation}` and `\begin{align}...\end{align}` are literal markdown.

The parser must not call KaTeX or another renderer to decide whether input is math. Money-vs-math ambiguity must be handled by parser semantics and regression tests.

## Streaming

The streaming API receives the latest accumulated source string.

For a parser session:

- if the new source extends the previous unfinished source, reuse append-only parser state
- if it does not extend the previous source, reset and reparse
- after finalization, the next unfinished parse starts a new parser workspace
- finalized incremental output must match one-shot parsing for the same source

The parser should backtrack only as far as markdown ambiguity requires.

The session may keep mutable internal state. That state is private, single-writer, and not concurrent-safe.

## Optimistic projection

Optimistic projection is required for visual stability during streaming. The goal is to avoid raw markdown or temporary plain text flashing before the final formatting is known. It is not a performance shortcut.

The parser must distinguish:

- finalized syntax
- open constructs
- optimistic nodes synthesized for in-progress rendering

Optimistic projection must not pretend the internal parse is finalized. Published nodes that depend on unfinished input must be marked with `data.mistralMarkdown`.

High-confidence constructs should keep their eventual shape while waiting for a closer. Ambiguous tails should be hidden until more input arrives or finalization resolves them.

## Public API

The package API must stay small:

- `parseMarkdown(source, options?)`
- `createMarkdownSession(options?)`
- `useMistralMarkdown(source, options?)` from `@mistral/markdown/react`
- `unstable_transforms` as an experimental AST projection hook

The parser session should expose one call: `parse(source, isDone?)`.

Experimental smoothing may exist as React presentation state around a parser session, but it must stay outside the root API and must not create a separate parser dialect or correctness path.

Snapshots are read-only by contract. Consumers must not mutate them. The package should preserve reference identity for unchanged AST subtrees so renderers can skip unchanged branches.

`sourceLength` is JavaScript string length, measured in UTF-16 code units.

## Transforms

`unstable_transforms` may project parsed AST nodes into consumer-owned nodes before publication.

Transforms must:

- run after parsing
- stay outside parser syntax
- stay outside parser state
- be synchronous and deterministic
- return the same child array when unchanged

Transform overhead must be benchmarked separately because transforms run on every published streaming snapshot.

## Performance

The main performance target is cumulative CPU across append-only streaming sessions.

The parser should:

- beat full-reparse baselines for streaming messages
- avoid avoidable allocation churn on frequent small appends
- keep one-shot parsing in the same order of magnitude as fast JavaScript parsers on message-shaped workloads
- avoid known quadratic behavior in supported syntax

Benchmark numbers and interpretation belong in `docs/perf-report.md`.

## Correctness

The package must track official CommonMark and GFM corpora through the custom spec harness. Dialect overlaps must be explicit harness skips, not runtime parser modes.

Parser tests must cover:

- focused syntax regressions
- finalized incremental output matching one-shot output
- optimistic projection behavior
- Le Chat math compatibility
- real-world sanitized message fixtures

## Boundaries

The package does not own:

- HTML rendering
- DOM or React Native rendering
- markdown serialization
- message-part preprocessing
- directive parsing
- app-specific custom-element rendering
- mobile-specific text grouping
- arbitrary middle-of-document editing
- public parser-state serialization

If persistence, forking, or cross-thread parser handoff becomes necessary, add a separate checkpoint API. Do not expose the live parser workspace through snapshots.
