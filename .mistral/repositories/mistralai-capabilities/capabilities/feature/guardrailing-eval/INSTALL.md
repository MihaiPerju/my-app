# Install — `@mistralai-capabilities/feature-guardrailing-eval`

Adds a harness that scores a moderation scanner against a labeled dataset (macro-F1,
unsafe-recall, false-positive-on-safe, over-blocking, per-group accuracy) on
`mistralai-evaluations`.

## Prerequisites

- Sibling capabilities: `core`, `evals`, `guardrailing`.
- A scanner implementing `ModerationScanner` (async `classify(text)`). To score the `guardrailing`
  capability's guardrail, use `GuardrailingScanner` from
  `mistralai_capabilities.guardrailing_eval.adapters`.
- A labeled dataset with ground truth at `ground_truth.expected` on each record, one of `safe`,
  `oos_question` or `unsafe`; the example reads the `message` / `answer` fields and groups by
  `slice` / `language`.
- `MISTRAL_API_KEY` (declared by `core`), exported in the shell: the example reads it from the
  environment.

## Install

```bash
mistral apps capability add guardrailing-eval
bun run install-all   # sync the new dependencies
```

Then copy and adapt `tools/run_guardrailing_eval.py`: replace `ExampleScanner` with your scanner
and `load_dataset` with your dataset loader, then run it with
`bash tools/uv.sh run --no-sync python tools/run_guardrailing_eval.py`.
