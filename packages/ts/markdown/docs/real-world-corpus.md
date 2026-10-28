# Real-world Le Chat corpus

This corpus is a sanitized sample of production Le Chat assistant messages used to keep `@mistral/markdown` aligned with the real LLM-message workload.

## Data handling

- Raw API responses are local-only under `.scratch/real-world-corpus/` and must not be committed.
- Checked-in fixtures contain only synthetic fixture ids, feature buckets, and sanitized markdown source.
- Sanitization strips or replaces emails, UUIDs, long token-shaped strings, original URLs, local user paths, direct user names, Slack-style user ids, and obvious phone-number-shaped values.
- Messages that looked like tests or sensitive personal/security material were skipped.

## Current corpus

- `tests/fixtures/real-world-messages.ts` contains 200 assistant-message fixtures.
- Bucket coverage includes prose, emphasis, strong, lists, ordered lists, headings, tables, links, code blocks, HTML, math-looking content, block quotes, and long replies.
- `tests/real-world-corpus.test.ts` verifies the corpus stays sanitized.
- The benchmark suite includes one full-corpus parse case and four streaming cases sourced from this corpus: table-heavy, raw HTML/code, math/HTML, and mixed replies.

## Legacy pipeline comparison

The comparison target is the Le Chat remark mdast pipeline:

- `remark-parse`
- the parser-relevant subset of `getSharedMessagesRemarkPlugins()`: GFM, math, `<br>` conversion, and repeated thematic-break hiding
- directive/custom-element plugins are intentionally not included in this package-level comparison because directives are being sunset and custom elements are handled outside the parser core
- normalized positions removed

The checked-in corpus has 11 known mdast mismatches:

- Repeated thematic breaks are collapsed by Le Chat’s remark plugin but not by `@mistral/markdown`: `real-world-002`.
- HTML/raw JSX handling differs around indentation, block boundaries, or partially parsed tags: `real-world-007`, `real-world-009`, `real-world-011`, `real-world-013`, `real-world-024`, `real-world-055`, `real-world-147`, `real-world-158`.
- URL escaping differs for SVG-ish markdown links: `real-world-048`, `real-world-080`.

Decisions:

- The finalized incremental `~50ms` / optimistic strikethrough leak was a correctness bug and is fixed in the parser.
- Remark is the compatibility target for fenced-code trailing newline handling. `@mistral/markdown` now strips the trailing fence newline from code `value`; the HTML renderer adds the CommonMark rendering newline back at render time.
- The list `spread` mismatch affected compact/non-compact list rendering and is fixed against GFM/mdast semantics.
- Repeated thematic-break collapse is legacy Le Chat cleanup, not core markdown parsing. We do not plan to implement it in `@mistral/markdown` because the product path is moving away from that plugin behavior.
- URL escaping can be aligned with remark if easy, but it is lower priority than the above items.
- HTML/raw JSX differences are less clear. Some remark outputs preserve indentation more closely, while some `@mistral/markdown` outputs keep more source in a single HTML node. Treat them as renderer-impact bugs only if mobile/web rendering differs.

## Incremental parity

The real-world incremental parity test covers all 200 checked-in fixtures and requires finalized incremental ASTs to match one-shot ASTs.

The fixed gaps included table cells where values like `~50ms` could retain an optimistic strikethrough projection after finalization, HTML/SVG block-boundary differences caused by streamed indentation prefixes, and JSX-ish inline HTML split differences caused by stale inline cache reuse. Finalization still uses the incremental dirty range; it now keeps whitespace-only unfinished lines dirty and avoids reusing prior tail inline caches when unresolved inline brackets make the final split unsafe.
