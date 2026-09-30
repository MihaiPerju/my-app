---
name: capability-guardrailing-eval
description: The moderation-policy quality harness — a fail-closed label contract, the pure scoring math, the `Evaluator`/`RunEvaluator` metric factories on `mistralai.evaluations`, and the scanner→task seam (`make_task`, `GuardrailingScanner`). Use when scoring a guardrail or moderation policy, when wiring a scanner into the harness or adapting the `guardrailing` capability into one, when choosing or reading a metric (macro-F1, unsafe-recall, fp-on-safe, over-blocking, per-group accuracy), or when a prediction or ground-truth label is scored wrong.
---

# Guardrailing Eval

Reusable core that measures moderation-policy **quality**: a fail-closed label contract, pure scoring math, `Evaluator`/`RunEvaluator` factories on `mistralai.evaluations`, the scanner→task seam, and a canonical adapter over the runtime guardrail. It owns **how** to measure (label contract + metrics); the app owns **what** (the scanner with its pinned prompts/model/thresholds, the labeled dataset, the taxonomy). The enforcement gate (`guardrails.scan`, `Guardrail`) is `capability-guardrailing`; the generic eval journey is `capability-evals`.

## Where things live

| Path | What |
| --- | --- |
| `tools/run_guardrailing_eval.py` | Copy-and-adapt runner: two runs (pre 3-way, post binary) off one core; replace its `ExampleScanner` + empty `load_dataset`. Under `tools/` so uv needs no `pyproject.toml`. |
| `mistralai_capabilities.guardrailing_eval` | Package root: eager SDK-free re-exports + lazy `make_task`/`ModerationScanner`/`TaskFn` via `__getattr__`. |
| `.schema` | Label spaces (`ModerationLabel`, `EvalLabel`), fail-closed `normalize_prediction`/`is_parse_failure`, `ClassificationOutput`, `expected_label`. |
| `._scoring` | Pure SDK-free math: `majority`, `macro_f1`, `one_vs_rest_pr`, `rate_where`, `accuracy_by_group`. |
| `.metrics` | `Evaluator`/`RunEvaluator` factories + `default_evaluators()`/`default_run_evaluators()` (needs `mistralai.evaluations`). |
| `.runner` | `ModerationScanner` protocol + `make_task`. |
| `.adapters` | `GuardrailingScanner`, canonical adapter running the `guardrailing` `Guardrail` (pulls guardrailing runtime). |

## Add / run an eval

A scanner is anything satisfying `ModerationScanner`: `async classify(text: str) -> ClassificationOutput`.

1. Copy `tools/run_guardrailing_eval.py`; implement `load_dataset` + a scanner (or reuse the runtime guardrail via `adapters.GuardrailingScanner`, which maps `out_of_scope → oos_question` and fails closed on unmapped enums).
2. `make_task(scanner, *, field=...)` wraps it into the per-row task `mistralai.evaluations` runs — `field` = record key (`message` pre-gen, `answer` post-gen).
3. Score: `default_evaluators()` (per-row: `classification_correct`, `fp_on_safe`, `parse_failure`) + `default_run_evaluators()` (cross-row: `macro_f1`, `fp_on_safe_rate`, `unsafe_recall_rate`, `over_blocking_failures`). Pass your run's `classes` to `macro_f1_run_evaluator` for the binary post pass; add `per_group_accuracy_run_evaluator("slice"|"language")` for breakdowns (`Score.metadata` holds the per-group map / offending prompts).

Two runs off one core: pre-gen judges the user message 3-way (`safe|oos_question|unsafe`), post-gen judges the answer binary (`safe|unsafe`) — same metrics, different `field`/`classes`.

## Gotchas

- Fail-closed everywhere but ground truth: `normalize_prediction` collapses `malicious`/parse-fail/unknown/non-dict → `unsafe`, `make_task` turns scanner exceptions into `parse_failed`, `majority([])` → `unsafe`; only `expected_label` fails **loud** (raises on missing/bad `ground_truth["expected"]`).
- `EvalLabel` (`safe|oos_question|unsafe`) is the scored space — `malicious` collapses into `unsafe`; ground truth read off `input_record["ground_truth"]["expected"]`.
- Package root stays SDK-free; `.metrics` (SDK) and `.adapters` (runtime) are separate imports, never re-exported. `test_sdk_contract.py` pins this.
