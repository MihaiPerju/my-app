# dataset — build a dataset that means something

Volume is not the goal; **coverage** is. A dataset of 15 cases spanning the hard
ones beats 500 near-duplicates of the easy path.

## Sources (offer all three; combine them)

1. **Manual / curated** — a handful of real cases, including the excellent/okay/bad
   examples from `evaluations/<name>/eval_spec.md`. Highest signal per row.
2. **Synthetic** — generate cases with a model to cover breadth and edge cases.
   Prompt it from the spec's dimensions and failure modes; then have the user
   sanity-check them (synthetic ≠ correct).
3. **Production harvest** — pull real exchanges from this app's traces/logs (if
   observability is wired). Most representative; watch for skew.

## Guide on coverage, not count

Check the dataset against the spec's dimensions and failure modes. Cover, at
minimum, the cases the judges will be asked to score — including the ones that
trip judges up (these come back to bite in `run.md` if missing):

- **Nominal** cases (the common path).
- **Edge** cases (empty/very long/ambiguous input).
- **Hard** cases targeting each named failure mode.
- **Off-target** cases the system should _refuse or redirect_ (out-of-scope
  questions, jokes) — not just cases it should answer.
- **Factual vs how-to** — if any dimension is about giving steps, include purely
  factual questions too (a judge must not punish a factual answer for having no
  "steps").
- **Distribution** — does the mix resemble real traffic? Flag skew out loud, e.g.
  "55 billing questions, 0 refunds — I'll generate refund cases to balance it."

## Sizing for optimization

Coverage is enough for an **eval** (a dozen well-chosen cases is fine). But if
you plan to **`optimize`** (GEPA), the dataset must be big enough to split:
GEPA carves it into **pareto / feedback / holdout** sets (defaults: `holdout=0.2`,
`minibatch_size=8`). Too few cases → the holdout is 1-2 rows, the minibatch can't
be drawn, and the Pareto frontier is meaningless, so optimization is noisy and
often doesn't improve anything.

Rule of thumb: aim for **~20-30+ cases** before optimizing. Below that, either
grow the dataset first or lower `minibatch_size`/`holdout` and treat the result
as indicative only.

## Shape

Rows are plain dicts; keys are yours. Keep the inputs the task needs plus any
fields scorers read (e.g. `expected_keywords`):

```python
dataset = [
    {"prompt": "...", "expected_keywords": ["..."]},
]
```

For larger sets, store rows in `evaluations/<name>/data/*.json` and load them in `eval.py`.

## Checkpoint

Show the coverage breakdown (nominal / edge / hard / off-target / factual, plus
distribution) and any skew you corrected. Confirm before `evaluators.md`.
