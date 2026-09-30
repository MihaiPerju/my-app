# run — run, read, and feed back

## Run it

```bash
python evaluations/<name>/eval.py     # or your project's runner, e.g. uv run python evaluations/<name>/eval.py
```

(Run from an environment where the app's handler/prompt import and the
`mistralai-evaluations` SDK is installed.) Report the printed `run.run_url`
(AI Studio → Observability → Evaluate).

## Interpret honestly

Don't just report the average — the average hides the problem.

1. **Per-dimension:** which evaluator is dragging the score? Read
   `run.statistics[name]` (avg/min/max/std) and its PASS/FAIL goal verdict. A
   passing average with **min = 0.0** hides per-case failures — chase the min.
2. **Per-record:** which cases fail, and _why_? Read the judge **rationales** —
   they cluster ("all failures are refund questions where the answer invents a
   window").
3. **Name the pattern, not the number.** "0.62; all 12 failures are one failure
   mode" is actionable. "0.62" is not.

Display levels: `run.show(level="run" | "records" | "generations" | "scores")`.

## Triage: real fault vs judge artifact (do this before acting)

The run is also a test _of your judges_. For each failing case, decide:

- **Real model fault** — the answer genuinely violates the dimension → this is a
  finding; it's what optimization will fix.
- **Judge artifact** — the answer is fine but the judge mis-scored it (punished a
  factual answer for having no steps; applauded an evasion because it didn't know
  the rules; ignored an off-target case). This is a **calibration gap**, not a
  model problem.

If you find artifacts, **do not trust the metric yet.** Go back to
`evaluators.md`: add these exact cases to `evaluations/<name>/calibrate.py` as controls
(with negative controls), fix the rubric, re-calibrate, then re-run. Loop until
the failures that remain are real faults, not judge noise. This run→calibrate
loop is the point — the first run almost always exposes blind spots the
calibration set didn't cover.

## Compare over time

Each `evaluation.run()` is a new run under the same `Evaluation`, so scores are
tracked across runs in AI Studio. After a change, re-run and confirm you moved
the metric you meant to and didn't regress another.

## Gate CI (optional, high-value)

Turn the eval into a regression gate:

```python
stats = run.statistics["quality"]
assert stats.avg >= 0.6, f"quality regressed: {stats.avg:.2f}"
```

Wire `python evaluations/<name>/eval.py` into CI so every PR is checked.

## Checkpoint

Summarize: the headline metric, the dominant _real_ failure pattern (after
removing judge artifacts), and the diff vs the previous run. If scores plateau on
real faults and the user wants to improve them, suggest `optimize.md` (opt-in —
it creates real runs).
