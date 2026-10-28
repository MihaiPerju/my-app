# Incremental parsing notes

This document records parser-internal details that are too specific for `docs/architecture.md`.

## Source model

The session stores the source as a JavaScript string.

`sourceLength` in public snapshots is `source.length`, so it is measured in UTF-16 code units.

A segmented source store is not part of the design. Add one only if allocation profiles show that the string buffer is a real cost.

## Dirty window

Append-only parsing works by rebuilding a suffix of the document.

The dirty window can start at:

- an open block construct
- a trailing block that can still accept continuation text
- an unresolved inline delimiter context
- a reference or footnote definition that can affect later inline resolution
- a conservative boundary before the appended chunk

The parser stores the selected rollback point as `reparseFromOffset`.

Pending constructs have two jobs:

- choose the next streaming dirty window
- keep enough state for finalization and late reference-definition upgrades

Those jobs are related but not identical. A pending paragraph, list, code fence, math block, HTML block, reference definition, or block continuation can force the next streaming parse to rebuild from its start offset. A dormant `inlineBracket` candidate is different: it records that earlier bracketed text may need another pass when finalizing or when definitions change, but it should not pin every unrelated tail append to that earlier paragraph.

## Block continuation

Some complete-looking trailing blocks are still open to future input while streaming.

Examples:

- a paragraph followed by a line that may become a setext heading underline
- a list item that may receive another indented child
- an HTML block whose boundary depends on later lines
- whitespace-only trailing lines that may become indented content

The block parser records these candidates while it parses. State stores the resulting rollback point as a `blockContinuation` pending construct.

## Inline append safety

A scanned inline prefix is not automatically safe to reuse.

The next chunk can still change:

- delimiter runs
- partial character references
- closed link or image labels that may gain a destination
- trailing GFM literal-autolink candidates

Inline caches therefore carry an append-safe boundary and small continuation hints. The cache layer consumes parser-produced boundaries instead of guessing from suffix text.

The inline event tape is internal. It is not a public token stream and it is not a serialization format. Its job is to keep scanner output cheaper and more explicit than mdast while preserving mdast-compatible publication during a rebuild. Bracket/link resume state is still separate because unresolved brackets need mutable parser state and projection anchors for structural sharing.

## Finalization

Finalization uses the same dirty-window mechanism as streaming updates. It must converge with one-shot parsing without replacing the session result with a fresh full parse.

Before finalization, the state moves `reparseFromOffset` back to the earliest pending construct. That gives dormant inline brackets and other retained constructs a final chance to resolve while still using the incremental parser path.

When unresolved inline brackets make a finalized tail split unsafe, projection rebuilds that tail without reusing stale inline caches.
