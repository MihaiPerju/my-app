# Math cleanup plan

This document records the math scope we want for `@mistral/markdown` and the cleanup steps needed to keep the package aligned with Le Chat.

## Goal

Keep math support narrow, predictable, and fast:

- parse the math forms Le Chat actually uses
- avoid baking KaTeX validation into parsing
- keep markdown input raw instead of normalizing it through a heavyweight pre-pass

## Supported math syntax

- inline dollar math: `$...$`
- inline parenthesized math: `\(...\)`
- display dollar math: `$$...$$`
- display bracketed math: `\[...\]`

TeX environments such as `\begin{vmatrix}...\end{vmatrix}` remain part of the math payload when they appear inside one of the supported delimiters above.

## Explicitly out of scope

- bare `\begin{equation}...\end{equation}` as a markdown block delimiter
- bare `\begin{align}...\end{align}` as a markdown block delimiter
- broad remark-math compatibility where it does not help Le Chat
- parser-side semantic validation through KaTeX

## Parser rules

- `$...$` remains intentionally conservative so common currency forms stay literal
- legacy-visible ambiguous-dollar behavior is locked with parser regression tests instead of preserving the old KaTeX-probing pre-pass
- `\(...\)` and `\[...\]` are explicit math delimiters and should parse directly from raw model output
- padded parenthesized math such as `\( f(x) \)` should parse without requiring a preprocessing pass
- unchanged math subtrees should keep structural sharing like the rest of the AST

## Migration direction for Le Chat

The current Le Chat pipeline still does two math-related passes:

1. `processLaTeX()` rewrites some delimiters and probes inline math with KaTeX
2. `rehype-katex` renders math again

The target integration is:

1. feed raw markdown into `@mistral/markdown`
2. let the parser recognize math lexically
3. render `math` / `inlineMath` once at the presentation layer

Le Chat-specific custom-element decoding should stay outside this package. The parser should preserve inline HTML and HTML blocks as syntax. App adapters can decode those `html` leaves into richer message parts after parse.

Reference syntax should move the same way: emit custom elements or plain HTML instead of directive syntax, then decode those leaves in the Le Chat adapter. That is the path to dropping the directives extension from the stack.

That migration does not require this package to accept bare `\begin{equation}` or `\begin{align}` as standalone markdown delimiters.

## Cleanup checklist

- [x] remove bare-TeX claims from package docs
- [x] keep the parser focused on Le Chat delimiters
- [x] import regression cases from Le Chat math/currency tests
- [x] lock a small golden corpus for ambiguous dollar cases from the legacy pipeline
- [x] import selected remark-math ecosystem edge cases that match the narrower scope
- [x] keep the package honest about unsupported bare TeX delimiters
