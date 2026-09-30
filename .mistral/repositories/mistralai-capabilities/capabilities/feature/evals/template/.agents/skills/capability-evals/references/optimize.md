# optimize — improve against the eval

Optimization is `run` + a search space + an algorithm. The objective is derived
automatically from each evaluator's `direction` (`maximize`/`minimize`, default
`maximize`) and its `weight` — you don't specify a separate objective. `Goal` is
a pure pass/fail gate, not a direction. This is the last phase: it _reuses_ the
eval you already built (and trust) as its fitness function.

**Opt-in.** It runs many evaluations (real cost + time) and reads runs back from
AI Studio, so it cannot run `local=True`. It also requires the backend flag
`obs_evaluations_optimizer` to be enabled for the workspace (else the
`/optimizations` API returns 404). Confirm both with the user before starting.

**Only optimize once the judges are trusted.** If `run.md` is still surfacing
judge artifacts, fix calibration first — otherwise you'll optimize toward a
weak scorer and "improve" the gaming, not the app.

**GEPA needs a dataset that isn't tiny.** It splits your data into pareto /
feedback / holdout sets (defaults: `holdout=0.2`, `minibatch_size=8`); with too
few cases the holdout is 1-2 rows, the minibatch can't be drawn, and the Pareto
frontier is meaningless → noisy, unhelpful runs. Aim for **~20-30+ cases**; if
you're short, grow the dataset first (`dataset.md`), or lower
`minibatch_size`/`holdout` and treat the result as indicative only.

## What to make tunable

Wrap the field(s) to optimize in `Tunable`; leave the rest fixed. Usually the
prompt/instructions; the seed is the current value:

```python
from mistralai.evaluations import GEPA, Tunable, TunableSystem

system = TunableSystem(
    name="candidate",
    params={
        "instructions": Tunable("<current system prompt>"),  # optimized
        "model": "mistral-small-latest",                     # fixed
    },
)
```

Reuse the _same_ `dataset`, `task`, and `evaluators` from `evaluations/<name>/eval.py` —
that is the whole point; don't redefine them. Keep this in `evaluations/<name>/optimize.py`
(an episodic action, not part of the CI eval).

## Run the search

```python
result = await client.evaluation.optimize(
    project=Project(name="<app>"),
    evaluation=Evaluation(name="<what you're testing> — optimization"),
    dataset=dataset, task=task, evaluators=evaluators,
    system=system,
    algo=GEPA(iterations=8, holdout=0.2),   # or SimpleOptimizer(...) for a plain hill-climb
)
```

## Interpret the trajectory

- Report `baseline → best` and the gain, and _what changed_ in the winning
  candidate (the new instruction) — not just the number.
- Check it held on the **holdout**, not only the cases it was tuned on.
- Sanity-check the winner reads sensibly. If the gain looks like scorer gaming,
  go back to `evaluators.md`.

## Promote deliberately

Propose writing the winning prompt into the app's **shared prompt file** (e.g.
`prompt.py`). Because the eval imports that same file, promoting there updates the
app AND the eval baseline at once — one edit, no drift. But **let the human
promote it** — never auto-apply to production.

## Checkpoint

Show baseline→best, the winning change, the holdout result, and your gaming
sanity-check. Then hand promotion to the user.
