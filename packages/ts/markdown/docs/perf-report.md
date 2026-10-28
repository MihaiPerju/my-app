# Markdown performance report

This document records the benchmark shape for `@mistral/markdown`. It is a snapshot, not a promise: local CPU load can move absolute timings a lot. Compare ratios and hot cases before reading a single number too closely.

Snapshot:

- branch: `mg/markdown-dirty-tail-perf`
- date: `2026-06-27`
- runtime: Node `v22.20.0`
- focus: append-only Le Chat message rendering

Lower is better.

- Full parsing cases report `ms/parse`.
- Streaming cases report cumulative `ms/session` for the full append sequence.
- Values within roughly 5 to 10 percent should be treated as a tie.

## How to run the benchmarks

From the `ts/` root:

```bash
pnpm --filter @mistral/markdown bench:node
pnpm --filter @mistral/markdown bench:hermes
pnpm --filter @mistral/markdown bench:all
```

The benchmark cases live in:

- `scripts/benchmark-fixtures.ts`
- `scripts/benchmark-transform-cases.ts`
- `scripts/benchmark-core.ts`
- `scripts/benchmark-core-hermes.ts`

The Hermes runner uses the Hermes source pinned by the installed `@mistralai/react-native` package. If no host `hermes` binary is available, the runner may build one through the Le Chat Mobile Android project. That can be slow and can make local benchmark results noisy while native builds are active.

## Corpus

The suite is small on purpose. It covers message-shaped inputs rather than generic markdown documents.

Full parsing cases:

- short assistant reply
- long prose answer
- structured answer
- math and prices answer
- working steps list-heavy answer
- real-world assistant corpus

Streaming cases:

- short assistant reply, burst stream
- short assistant reply, character-by-character reveal
- long prose answer, burst stream
- open code fence
- late link tail
- late paragraph continuation
- late literal autolink tail
- math and prices burst stream
- working steps list-heavy token stream
- real-world table-heavy token stream
- real-world HTML/code token stream
- real-world math/HTML token stream
- real-world mixed token stream

The real-world cases came from sanitized Le Chat messages. They were added because a 20-longest-fixtures benchmark hid individual pathological inputs: long list streams, table-heavy answers, and raw React/HTML-looking code with many brackets.

## Comparison parsers

Node/V8 compares against:

- `remark + gfm + math`
- `markdown-it`
- `commonmark.js`
- `marked lexer`
- `micromark+mdast`
- `cmark-gfm native html`

Hermes compares against `remark`, `markdown-it`, and `commonmark.js`.

`commonmark.js` is a CommonMark-only baseline. It does not implement GFM literal autolinks, tables, task list items, footnotes, or the math dialect supported here. It is still useful as a raw parser-cost reference, but it is not feature-equivalent on Le Chat inputs.

`markdown-it` is closer but still not configured to match every feature in this package. Treat it as a fast JavaScript parser baseline, not as a drop-in replacement measurement.

`cmark-gfm native html` is a native C/GFM HTML-rendering baseline. It is not feature-equivalent: it renders HTML rather than mdast and does not implement the package's math/custom-element dialect. It is useful as a native full-parse/render ceiling. The Node package uses a native binding; on local pnpm installs with ignored build scripts, the row is skipped unless the binding has been built.

## Node/V8 sample, 2026-06-27

This sample was taken on branch `mg/markdown-dirty-tail-perf`, comparing the branch against its parent commit `22727736e96`. It includes the dirty-tail paragraph optimization, the inline event tape, and the cmark-gfm benchmark row.

### Branch before/after

Clean benchmark logs:

- before branch: `/tmp/mistral-markdown-before-bench.txt`
- after branch: `/tmp/mistral-markdown-after-bench.txt`

Headline scores from `pnpm --filter @mistral/markdown bench:compare /tmp/mistral-markdown-before-bench.txt /tmp/mistral-markdown-after-bench.txt`:

- Real-world streaming score: `1.43x` throughput, with `0/4` regressions above 5%.
- Full parse score: `1.11x` throughput, with `0/1` regressions above 5%.

| Case                                    |    Before |     After | Time Change |
| --------------------------------------- | --------: | --------: | ----------: |
| real-world table-heavy token stream     | 13.506 ms | 13.137 ms |       -2.7% |
| real-world HTML/code token stream       | 32.345 ms | 17.949 ms |      -44.5% |
| real-world math/HTML token stream       | 33.905 ms | 16.517 ms |      -51.3% |
| real-world mixed token stream           |  8.872 ms |  8.110 ms |       -8.6% |
| working steps list-heavy stream         | 36.358 ms | 34.808 ms |       -4.3% |
| real-world assistant corpus, full parse |  2.443 ms |  2.199 ms |      -10.0% |

The largest wins came from skipping impossible paragraph terminator probes for indented continuation lines. The inline event tape produced smaller additional wins by making inline scanner output an explicit internal representation instead of a one-off token list.

### Full parsing

| Case                            | `@mistral/markdown` | `remark + gfm + math` | `markdown-it` | `commonmark.js` | `marked lexer` | `micromark+mdast` | `cmark-gfm native html` |
| ------------------------------- | ------------------: | --------------------: | ------------: | --------------: | -------------: | ----------------: | ----------------------: |
| short assistant reply           |               0.012 |                 0.069 |         0.001 |           0.001 |          0.004 |             0.098 |                   0.004 |
| long prose answer               |               0.246 |                 3.250 |         0.107 |           0.046 |          0.255 |             3.262 |                   0.089 |
| structured answer               |               0.202 |                 4.996 |         0.148 |           0.119 |          0.407 |             4.617 |                   0.134 |
| math and prices answer          |               0.114 |                 2.638 |         0.122 |           0.047 |          0.171 |             2.265 |                   0.061 |
| working steps list-heavy answer |               0.274 |                 5.348 |         0.152 |           0.127 |          0.594 |             5.249 |                   0.111 |
| real-world assistant corpus     |               2.199 |                34.441 |         1.278 |           0.972 |          2.435 |            30.567 |                   0.855 |

### Streaming sessions

| Case                                    | `@mistral/markdown` session | `@mistral/markdown` reparse | `remark + gfm + math` reparse | `markdown-it` reparse | `commonmark.js` reparse | `marked lexer` reparse | `micromark+mdast` reparse | `cmark-gfm native html` reparse |
| --------------------------------------- | --------------------------: | --------------------------: | ----------------------------: | --------------------: | ----------------------: | ---------------------: | ------------------------: | ------------------------------: |
| short assistant reply, burst            |                       0.034 |                       0.140 |                         2.716 |                 0.055 |                   0.030 |                  0.120 |                     2.538 |                           0.164 |
| short assistant reply, character reveal |                       0.102 |                       0.529 |                        10.913 |                 0.214 |                   0.118 |                  0.480 |                     9.976 |                           0.647 |
| long prose answer, burst                |                       0.985 |                      29.713 |                       395.516 |                12.691 |                   5.635 |                 29.369 |                   383.808 |                           9.875 |
| open code fence                         |                       0.007 |                       0.009 |                         0.380 |                 0.009 |                   0.008 |                  0.010 |                     0.362 |                           0.024 |
| late link tail                          |                       0.416 |                       6.196 |                        82.183 |                 2.711 |                   1.218 |                  6.276 |                    82.804 |                           2.025 |
| late paragraph continuation             |                       0.327 |                       4.369 |                        62.477 |                 1.848 |                   0.820 |                  4.402 |                    58.523 |                           1.395 |
| late literal autolink tail              |                       0.584 |                       4.768 |                        25.306 |                 0.826 |                   0.363 |                  1.940 |                    24.948 |                           0.622 |
| math and prices burst                   |                       1.045 |                      24.761 |                       253.341 |                12.502 |                   4.993 |                 17.972 |                   242.207 |                           6.455 |
| working steps list-heavy token stream   |                      34.808 |                     324.631 |                      3573.917 |                98.954 |                  88.269 |                421.550 |                  3545.804 |                          82.470 |
| real-world table-heavy token stream     |                      13.137 |                     106.611 |                      1032.327 |                39.378 |                  35.244 |                108.115 |                  1021.384 |                          30.845 |
| real-world HTML/code token stream       |                      17.949 |                     120.985 |                       838.063 |                48.018 |                  33.439 |                 50.180 |                   825.518 |                          27.229 |
| real-world math/HTML token stream       |                      16.517 |                      54.022 |                       398.425 |                27.124 |                  18.579 |                 27.093 |                   389.688 |                          12.850 |
| real-world mixed token stream           |                       8.110 |                      71.033 |                       687.553 |                26.197 |                  23.279 |                 71.101 |                   678.822 |                          20.452 |

### Transform overhead

| Case                              | no transforms | noop transform | custom transform | Le Chat transforms |
| --------------------------------- | ------------: | -------------: | ---------------: | -----------------: |
| full projection fixture           |         0.134 |          0.159 |            0.161 |              0.204 |
| streaming projection token stream |        19.868 |         22.844 |           24.723 |             41.628 |

### Attempts Not Kept

These experiments were tried against the same real-world stream cases and reverted:

- Persisting line prefix metadata on every retained `Line` object helped code-like fixtures but regressed table-heavy and mixed streams.
- A local `parseParagraph` first-nonspace specialization failed a GFM table corpus case where a table can start immediately after paragraph text.
- Removing the inline stable-prefix verification looked faster in a focused run but regressed the full benchmark and was reverted.
- A narrow event-tape side path for plain text, code, HTML, and math passed only after conservative fallbacks, then regressed the hot HTML/code and math/HTML streams.
- A same-line append fast path for multi-line indented paragraphs passed tests but was not a clean full-benchmark win.

## Node/V8 sample

This historical sample was taken on 2026-06-03. The machine was not isolated, so absolute numbers are higher than some earlier local runs. Ratios and the relative hot cases are the useful part.

### Full parsing

| Case                            | `@mistral/markdown` | `remark + gfm + math` | `markdown-it` | `commonmark.js` |
| ------------------------------- | ------------------: | --------------------: | ------------: | --------------: |
| short assistant reply           |               0.039 |                 0.588 |         0.004 |           0.002 |
| long prose answer               |               0.642 |                15.256 |         0.647 |           0.149 |
| structured answer               |               0.611 |                18.309 |         0.709 |           0.348 |
| math and prices answer          |               0.307 |                 8.275 |         0.447 |           0.151 |
| working steps list-heavy answer |               0.650 |                18.479 |         0.288 |           0.561 |
| real-world assistant corpus     |              11.248 |               115.785 |         6.452 |           4.881 |

### Streaming sessions

| Case                                    | `@mistral/markdown` session | `@mistral/markdown` reparse | `remark + gfm + math` reparse | `markdown-it` reparse | `commonmark.js` reparse |
| --------------------------------------- | --------------------------: | --------------------------: | ----------------------------: | --------------------: | ----------------------: |
| short assistant reply, burst            |                       0.170 |                       0.418 |                        10.483 |                 0.126 |                   0.127 |
| short assistant reply, character reveal |                       0.420 |                       1.601 |                        81.186 |                 0.399 |                   0.401 |
| long prose answer, burst                |                       9.430 |                      68.689 |                      1390.787 |                39.360 |                  17.578 |
| open code fence                         |                       0.030 |                       0.022 |                         1.991 |                 0.018 |                   0.023 |
| late link tail                          |                       2.074 |                      16.020 |                       222.097 |                 5.420 |                   2.567 |
| late paragraph continuation             |                       1.050 |                       8.410 |                       228.541 |                 3.637 |                   2.890 |
| late literal autolink tail              |                       0.791 |                      14.271 |                        77.603 |                 2.866 |                   1.286 |
| math and prices burst                   |                       5.435 |                      44.475 |                      1080.443 |                25.332 |                  54.029 |
| working steps list-heavy token stream   |                     150.465 |                     762.948 |                     10341.784 |                98.459 |                 238.380 |
| real-world table-heavy token stream     |                      42.864 |                     332.819 |                      4285.770 |               116.756 |                 120.358 |
| real-world HTML/code token stream       |                      82.088 |                     284.750 |                      3573.889 |               120.540 |                  88.095 |
| real-world math/HTML token stream       |                     107.437 |                     186.952 |                      1284.188 |                62.212 |                  44.354 |
| real-world mixed token stream           |                      25.708 |                     182.539 |                       789.622 |                26.175 |                  23.509 |

### Transform overhead

| Case                              | no transforms | noop transform | custom transform | Le Chat transforms |
| --------------------------------- | ------------: | -------------: | ---------------: | -----------------: |
| full projection fixture           |         0.157 |          0.173 |            0.163 |              0.198 |
| streaming projection token stream |        21.145 |         23.542 |           28.527 |             41.818 |

Transforms run after parsing and before publication. They are benchmarked separately because product transforms can dominate parser savings during high-frequency streaming.

## Optimization checkpoints

Two streaming costs have dedicated benchmark coverage:

- List-heavy streams no longer reparse the whole trailing list when a token extends the last open paragraph.
- Dormant bracket candidates no longer pin the streaming dirty window to earlier closed paragraphs.

The important before/after shape from the profiling work:

| Case                                                   |               Before |                                                                        After |
| ------------------------------------------------------ | -------------------: | ---------------------------------------------------------------------------: |
| real-world table-heavy token stream, Node              |  about 51 ms/session | about 13 ms/session in an isolated run, 43 ms in the noisy 2026-06-03 sample |
| real-world mixed token stream, Node                    |  about 34 ms/session |  about 8 ms/session in an isolated run, 26 ms in the noisy 2026-06-03 sample |
| projection fixture token stream, no transforms, Node   |  about 73 ms/session |                                                          about 21 ms/session |
| real-world table-heavy token stream, Hermes            | about 644 ms/session |                                     about 150 ms/session in the post-fix run |
| projection fixture token stream, no transforms, Hermes | about 860 ms/session |                                     about 147 ms/session in the post-fix run |

The isolated Node numbers are more useful for parser deltas. The later full-suite sample is more useful for seeing which cases still deserve attention under normal laptop noise.

## Interpretation

The package is still doing the right work in the parser session. The remaining expensive cases are mostly long token streams with complex inline content, not repeated full-message reparses.

The architecture has not become a pile of fixture-specific fast paths. The fast paths are implementations of the same model:

- parser-owned dirty windows
- pending constructs that decide rollback and finalization work
- inline caches with append-safe prefixes
- conservative fallback to dirty-tail parsing

Future parser optimizations should fit that model. If a proposed change needs to recognize a particular fixture shape directly, it should stay out until a broader parser invariant explains it.

## App benchmark notes

The Android Flashlight runs are useful for app regressions, but they are not clean parser benchmarks. When parsing gets faster, React can consume more intermediate stream states. Wall time or FPS alone can therefore look flat even when parser CPU dropped.

For app rollout, report these together:

- parser time
- markdown render count
- final-content render time
- FPS
- JS CPU

If Mobile needs lower CPU during streaming, throttle AST publication to React rather than slowing the parser session. The parser should still ingest appends cheaply; the renderer does not need every token-sized intermediate state. The smoothed session is the right place for that policy: publish at an animation-frame or coarse cadence, and flush immediately when the message finishes.

## Next profiling target

Start from the remaining inline scanner and projection work in the long real-world token streams. Avoid adding more parser-state metadata until a profile shows which invariant is missing.
