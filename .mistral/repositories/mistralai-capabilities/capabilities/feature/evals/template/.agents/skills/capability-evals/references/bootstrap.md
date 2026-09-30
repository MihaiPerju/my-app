# bootstrap — close the loop on day one

Goal: a real run in AI Studio in ~10 minutes, on 2-3 cases. Correctness comes
later; momentum comes now.

The `<app>` and the evaluable unit were chosen in `scope.md`. Check that
`MISTRAL_API_KEY` is set and the harness imports. If it does not, install it with
your project's package manager (in a `mistral apps` app, see
`references/app-conventions.md` — the harness is the shipped `evals` package).

## Do this

**Write `evaluations/<name>/eval.py` yourself, adapting the skeleton below to what
`scope.md` found** — there is no hardcoded template to copy (that would overfit
one app shape). Fill the `<…>` placeholders from the discovered target: its
importable handler and its shared prompt.

```python
import asyncio
import os

from mistralai.evaluations import (
    Evaluation, Evaluator, Goal, Mistral, Project, Score, ScorerContext,
    System, TaskContext,
)

# Wire to the target scope.md found — the REAL code path, not a copy:
from <module> import <handler>                # e.g. from chat import MistralChat
from <prompt_module> import <PROMPT>          # the app's shared prompt (single source)

client = Mistral(api_key=os.environ["MISTRAL_API_KEY"])

dataset = [{"prompt": "..."}]                 # 2-3 real cases for now
# "prompt" is just the row key; keep it consistent with dataset.md / evaluators.md
# (task and scorers must read the SAME key you write here).

async def task(ctx: TaskContext) -> str:
    # call the app's handler; the config under test comes from System.params:
    return await <handler>(ctx.input_record["prompt"], ctx.system.params["instructions"])
    # No importable handler? Call the model directly, still reading the prompt
    # from ctx.system.params["instructions"] (never hardcode it in the task).

def response_present(ctx: ScorerContext) -> Score:
    # a liveness floor — the cheapest possible deterministic scorer.
    ok = bool(ctx.output and ctx.output.strip())
    return Score(value=1.0 if ok else 0.0, rationale="non-empty" if ok else "empty")

evaluators = [Evaluator(name="response_present", scorer=response_present, goal=Goal.gte(1.0))]
# Add a quality judge next — see evaluators.md (a judge is a plain inline fn).

async def main() -> None:
    run = await client.evaluation.run(
        project=Project(name="<app>"),
        evaluation=Evaluation(name="<what you're testing>"),
        system=System(name="baseline", params={"instructions": <PROMPT>}),  # default = the app's live prompt
        dataset=dataset, task=task, evaluators=evaluators,
    )
    run.show(level="records")
    print(f"\n{run.run_url}")

if __name__ == "__main__":
    asyncio.run(main())
```

The two things that make this evaluate the REAL app (not a copy):

1. `task` calls the app's **handler** (same code path the app runs).
2. `System.params["instructions"]` defaults to the app's **shared prompt** — so
   editing the prompt in one place moves the app AND the eval, and it's recorded
   - visible on the AI Studio run. (Judges read the same via `ScorerContext.system`;
     per-case ground truth goes in the dataset row instead.)

Then: seed 2-3 real cases (full dataset is `dataset.md`), and set meaningful
`Project` / `Evaluation` names.

**Run it** and surface the URL (use your project's runner if it has one, e.g.
`uv run python …`):

```bash
python evaluations/<name>/eval.py
```

Report the printed `run.run_url` (Observability → Evaluate → Evaluations).

## Checkpoint

Confirm the run appears in AI Studio and the scores are non-degenerate. **All 0
or all 1 is a red flag** — usually a broken task or an uncalibrated judge, not a
real result. If you see it, note it and plan to fix it in `evaluators.md`. Then
route to `dataset.md`.
