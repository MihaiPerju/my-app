# Prior art

This document captures the parser implementations that are most relevant to Mistral Markdown's goals: mdast-compatible output, CommonMark/GFM compliance, streaming-friendly or incremental architecture, math support, and state-of-the-art performance.

Research for this document used local scratch clones in `.scratch/repos/` plus the upstream READMEs and docs from those repositories.

## Evaluation criteria

- Spec posture: CommonMark and GFM support, plus the breadth of extension support.
- Output model: AST, token stream, event stream, or callback API.
- Streaming or incremental fit: append-friendly parsing, fragment reuse, or explicit streaming constraints.
- Performance posture: benchmark claims, pathological-input handling, fuzzing, and low-allocation design.
- Relevance to us: whether the implementation suggests a good architecture for a TypeScript-first, mdast-compatible parser.

## Comparison table

| Project                                                              | Language   | Primary model                                     | Spec / extensions                                                                           | Incremental / streaming story                                                                                                                | Why it matters                                                                                      |
| -------------------------------------------------------------------- | ---------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [`micromark`](https://github.com/micromark/micromark)                | JavaScript | State-machine tokenizer with token/event pipeline | 100% CommonMark, 100% GFM via extensions, math, frontmatter, MDX, directives                | Has a Node stream interface, but its docs explicitly note that markdown cannot truly stream and that events are buffered before final output | Closest JS baseline for spec rigor, tokenizer architecture, and extension design                    |
| [`remark` / `remark-parse`](https://github.com/remarkjs/remark)      | JavaScript | mdast-first unified pipeline                      | CommonMark by default, plugins for GFM, math, frontmatter, directives                       | No incremental parsing model in core                                                                                                         | Best AST ergonomics and ecosystem fit; weak on raw parser performance                               |
| [`@lezer/markdown`](https://github.com/lezer-parser/markdown)        | TypeScript | Incremental syntax tree parser                    | CommonMark with extension bundles such as GFM tables, task lists, and strikethrough         | True incremental parsing by reusing tree fragments; trades away some strict CommonMark behavior such as link reference validation            | Best direct inspiration for append-only reparsing and tree reuse                                    |
| [`markdown-it`](https://github.com/markdown-it/markdown-it)          | JavaScript | Rule-based token pipeline to HTML                 | CommonMark-oriented core with GFM tables and strikethrough built in; large plugin ecosystem | No incremental parsing, no AST diff model                                                                                                    | Strong speed/extensibility baseline in JS; useful benchmark target                                  |
| [`marked`](https://github.com/markedjs/marked)                       | JavaScript | Fast HTML-oriented compiler                       | Broad markdown flavor support, positioned around speed                                      | No incremental parsing, no AST-first API, no output sanitization                                                                             | Useful "fast parser" benchmark target, but not an architecture match                                |
| [`commonmark.js`](https://github.com/commonmark/commonmark.js)       | JavaScript | Reference AST + renderers                         | CommonMark reference implementation                                                         | No incremental parsing                                                                                                                       | Reference-level behavior and a JS AST API; important correctness baseline                           |
| [`cmark`](https://github.com/commonmark/cmark)                       | C          | Reference AST + renderers                         | CommonMark reference implementation                                                         | No incremental parsing                                                                                                                       | Gold-standard compliance and performance reference; useful for pathological cases and test strategy |
| [`markdown-rs`](https://github.com/wooorm/markdown-rs)               | Rust       | State machine -> events -> mdast / HTML           | 100% CommonMark, 100% GFM, MDX, frontmatter, math                                           | No public incremental API                                                                                                                    | Best non-JS sibling to micromark; strong inspiration for state/event/AST layering                   |
| [`MD4C`](https://github.com/mity/md4c)                               | C          | Push parser with callbacks                        | CommonMark 0.31, tables, task lists, autolinks, LaTeX math, more                            | Not incremental, but explicitly optimized for linear parsing and low memory                                                                  | Good reference for low-overhead push parsing and math handling                                      |
| [`pulldown-cmark`](https://github.com/pulldown-cmark/pulldown-cmark) | Rust       | Pull parser emitting events                       | CommonMark with optional footnotes, tables, task lists, strikethrough                       | No incremental parsing                                                                                                                       | Strong inspiration for low-allocation event streams and source-map-friendly APIs                    |

## Detailed notes

### `micromark`

- Language: JavaScript
- Repo: [`micromark/micromark`](https://github.com/micromark/micromark)
- Why it stands out:
  - The parser is a state machine that accounts for every byte and keeps positional data.
  - It targets full CommonMark compliance and full GFM coverage through maintained extensions.
  - It already supports math, frontmatter, and MDX-adjacent extensions.
  - Its readme documents a clear parse pipeline and a sibling Rust implementation (`markdown-rs`), which is a strong sign that the architecture is portable and deliberate.
- Weaknesses for our goals:
  - The core output is tokens/events, not mdast.
  - The readme is explicit that markdown cannot be "truly streamed", so the streaming interface is not the same thing as incremental AST updates.
  - Extension authoring is powerful but fairly complex.
- Relevance:
  - This is the best JavaScript implementation to study for spec rigor, tokenizer structure, and extension boundaries.

### `remark` / `remark-parse`

- Language: JavaScript
- Repo: [`remarkjs/remark`](https://github.com/remarkjs/remark)
- Why it stands out:
  - It is the most established mdast-first ecosystem in JS.
  - It gives us the most realistic target for mdast compatibility and downstream transformations.
  - Plugins already exist for GFM, math, frontmatter, MDX, and directives.
- Weaknesses for our goals:
  - It is optimized for transforms and ecosystem composability, not for raw parsing throughput.
  - Incremental append-only parsing is not part of the core architecture.
- Relevance:
  - Mistral Markdown should be mdast-compatible enough to replace or interoperate with this ecosystem where it matters.

### `@lezer/markdown`

- Language: TypeScript
- Repo: [`lezer-parser/markdown`](https://github.com/lezer-parser/markdown)
- Why it stands out:
  - It is explicitly incremental and can consume fragments of previous trees.
  - It exposes a configurable extension model for block and inline parsing.
  - It already solves the "editor parser" problem well enough to power CodeMirror.
- Weaknesses for our goals:
  - The docs are explicit that single-pass incremental behavior means it skips some strict CommonMark behavior, notably full link-reference validation.
  - Its compact syntax trees are not mdast.
- Relevance:
  - This is the clearest model for minimal backtracking and fragment reuse, and also the clearest warning about where correctness can degrade if we optimize too early.

### `markdown-it`

- Language: JavaScript
- Repo: [`markdown-it/markdown-it`](https://github.com/markdown-it/markdown-it)
- Why it stands out:
  - Mature, fast, extensible, and widely deployed.
  - Clear rule-based architecture with a strong plugin ecosystem.
  - Built-in support for some GFM syntax, with more available through plugins.
- Weaknesses for our goals:
  - Its center of gravity is HTML rendering, not AST-first parsing.
  - It does not provide an incremental parsing story.
  - Its extension surface is convenient, but not designed around a serializable incremental parser state.
- Relevance:
  - Strong JS benchmark baseline and useful reference for pragmatic extensibility.

### `marked`

- Language: JavaScript
- Repo: [`markedjs/marked`](https://github.com/markedjs/marked)
- Why it stands out:
  - Its positioning is unapologetically speed-focused.
  - The project emphasizes lightweight parsing without caching or long blocking work.
- Weaknesses for our goals:
  - It is HTML-first rather than mdast-first.
  - It does not sanitize output by default.
  - It does not expose an incremental parsing model.
- Relevance:
  - Good performance benchmark target, but not a design template for Mistral Markdown.

### `commonmark.js`

- Language: JavaScript
- Repo: [`commonmark/commonmark.js`](https://github.com/commonmark/commonmark.js)
- Why it stands out:
  - It is the JavaScript reference implementation for CommonMark.
  - It exposes a real AST API and tree walker, which makes behavior easy to validate.
  - The repo includes benchmark tooling.
- Weaknesses for our goals:
  - CommonMark-only, with no native GFM or math story.
  - No incremental parsing.
  - It is more useful as a correctness baseline than as a performance or architecture target.
- Relevance:
  - Important spec reference and useful baseline in any compatibility test matrix.

### `cmark`

- Language: C
- Repo: [`commonmark/cmark`](https://github.com/commonmark/cmark)
- Why it stands out:
  - This is the reference implementation behind the CommonMark spec effort.
  - It is benchmarked, fuzz-tested, and explicitly hardened against pathological inputs.
  - It parses to an AST and supports multiple renderers.
- Weaknesses for our goals:
  - CommonMark-only in the base repo.
  - Not incremental and not directly usable from TypeScript without bindings.
- Relevance:
  - This is the external correctness and robustness reference we should continuously compare ourselves against.

### `markdown-rs`

- Language: Rust
- Repo: [`wooorm/markdown-rs`](https://github.com/wooorm/markdown-rs)
- Why it stands out:
  - It mirrors the `micromark` philosophy but exposes mdast directly.
  - It is explicit about its internal split: parse -> events -> HTML or mdast.
  - It supports CommonMark, GFM, MDX, frontmatter, and math with a large test corpus and fuzzing.
- Weaknesses for our goals:
  - No incremental append-only API.
  - Rust is an inspiration source, not a drop-in implementation for this package.
- Relevance:
  - This remains a strong precedent for state-machine rigor and mdast projection, but the current package has not adopted a dense event layer.

### `MD4C`

- Language: C
- Repo: [`mity/md4c`](https://github.com/mity/md4c)
- Why it stands out:
  - Extremely small embedding surface and a push-callback model.
  - Strong focus on linear-time behavior and low memory footprint.
  - Notably, it already ships LaTeX math span support.
- Weaknesses for our goals:
  - It is not AST-first by default.
  - The callback API is great for rendering pipelines, less so for incremental AST updates.
  - Not incremental.
- Relevance:
  - Useful inspiration for low-overhead scanning and callback/event boundaries, especially for math.

### `pulldown-cmark`

- Language: Rust
- Repo: [`pulldown-cmark/pulldown-cmark`](https://github.com/pulldown-cmark/pulldown-cmark)
- Why it stands out:
  - The pull-parser model is clean, allocation-aware, and source-map friendly.
  - It makes a strong case for separating parse and render without forcing an AST.
  - The event iterator model is easy to transform.
- Weaknesses for our goals:
  - Not mdast-first.
  - Not incremental.
  - Rust only.
- Relevance:
  - Good inspiration if a future profile justifies a lower-level event API or internal parser pipeline.

## Takeaways for Mistral Markdown

- The best tokenizer precedent is the `micromark` / `markdown-rs` family:
  - strict tokenizer/state machine
  - explicit scanner state
  - mdast-compatible projection
- The current architecture did not adopt a full token/event stream:
  - session state, dirty windows, inline caches, and mdast projection have been enough so far
  - the current bottleneck is inline scanning and tail reuse, not a missing generic event layer
  - a full event tape should be profile-driven, not assumed from prior art
- The best incremental precedent is `@lezer/markdown`:
  - reuse previous tree fragments
  - keep reparsing windows small
  - accept that naive single-pass incrementality can break spec behavior
- The best performance and robustness references are `cmark`, `MD4C`, and `pulldown-cmark`:
  - linear-time behavior matters as much as raw ops/sec
  - pathological-input resistance has to be part of the design, not an afterthought
- The checked benchmark baselines are:
  - `micromark`
  - `markdown-it`
  - `marked`
  - `commonmark.js`
  - `cmark-gfm` as a native C/GFM HTML-rendering baseline, not a feature-equivalent mdast comparison
- The public API should target mdast compatibility, but the internal representation probably should not be mdast:
  - mdast is a good interchange format
  - it is not obviously the densest or fastest internal parse representation
- Directives should not shape the core design:
  - the most relevant prior art treats HTML/custom syntax as explicit extensions
  - that aligns with the plan to sunset markdown directives in favor of HTML or custom elements
