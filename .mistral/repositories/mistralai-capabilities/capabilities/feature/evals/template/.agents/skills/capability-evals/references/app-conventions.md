# app-conventions — mistral-apps specifics for evals

The methodology in `SKILL.md` + the phase references own the _how_. This file is the **project
overlay** for a `mistral apps` generated app, and its overrides win: read it alongside whichever
phase doc you're in, and apply what follows on top of every generic step.

The one fact that reshapes everything below: **this app already ships an eval harness.** It is not
a blank slate where you scaffold a standalone `evaluations/<name>/eval.py` against the
`mistralai-evaluations` SDK. The harness is a real workspace package, `evals` (in
`packages/py/evals`), built on the **Workflow Evaluation Plugin**
(`mistralai.workflows.plugins.evaluations`), and its runs are **worker-driven** — dispatched to the
Temporal worker, not launched as a script. So the generic phases still frame the _thinking_ (scope,
dataset, evaluators, calibration, run, optimize), but the _artifacts_ land in that shipped package,
and the _runner_ is an nx target. This overlay pins those.

## State detection (overrides the guide's `find … evaluations/*/eval.py`)

Don't run the generic `find` for `evaluations/*/eval.py` and conclude "no eval exists" — this app's
eval does not live there. Detect it where it actually is:

```bash
ls packages/py/evals/src/evals/                          # the shipped harness (scorers, tracks, data)
cat packages/py/evals/src/evals/scorers.py               # every scorer both tracks use
ls packages/py/evals/src/evals/data/                     # the seed datasets (JSON)
```

The shipped harness IS an existing eval — two tracks, in fact (agent + search). Route accordingly:
you are almost always **extending** it (a scorer, a dataset case, a goal), not bootstrapping from
zero. Read `harness-architecture.md` for what it already does and how it is wired before you add to
it.

## Where evaluation work goes (overrides the guide's `evaluations/<name>/`)

The durable eval artifacts are the shipped `evals` package, not a standalone script directory:

```
packages/py/evals/src/evals/
  scorers.py                       # every scorer, deterministic + LLM-judge, plus run-level aggregators
  agent.py                         # agent-track config: AgentEvalParams, build_evaluators(), task helpers
  search/evaluators.py             # search-track config: SearchEvalParams, build_search_evaluators()
  dataset.py + data/*.json         # dataset loaders + the seed cases as JSON
  feedback.py                      # evaluator wiring for the harvested-feedback replay
```

To do each phase's work in this app:

- **scope / spec** — capture what "good" means in the case data and evaluator goals; there is no
  per-eval `eval_spec.md` file in the shipped tracks. If you want a written spec for a new track,
  keep it as a Markdown note beside the package, not inside a `src/` tree.
- **dataset** — add a case by editing JSON in `packages/py/evals/src/evals/data/` (no Python
  change; `dataset.py` loads it via `importlib.resources`).
- **evaluators** — add a scorer to `scorers.py`, add its name to `__all__`, then wire an
  `Evaluator(name=…, scorer=…, goal=Goal.gte(…))` in the track's `build_*` function
  (`agent.py` or `search/evaluators.py`).
- **run** — dispatch the worker workflow (see "Install & run" below), then read the run in AI Studio.
- **optimize** — the GEPA loop is already wired as `workflows/optimize.py` on the worker; it is
  operator-scheduled, not a script you write. See `harness-architecture.md`.

### The `evaluations/<name>/` standalone convention is a fallback here, not the default

The guide's standalone `evaluations/<name>/` script directory applies only if you need a **bespoke,
one-off** eval of a unit the shipped agent/search tracks don't cover. If you do:

- The container is `evaluations`, **never `evals`** — and here that rule is load-bearing, not
  cosmetic: `evals` is a real importable package in this workspace, so a folder named `evals` (or an
  `__init__.py` turning the eval dir into a package named `evals`) would shadow it and break every
  `from evals.… import …`.
- Keep it out of any `src/` tree so it is never mistaken for a workspace member, and never add an
  `__init__.py`.

For anything that belongs in the product's eval story, extend the shipped `evals` package instead.

## Scorers — import from the shipped `evals` package (don't re-inline)

The harness ships tested scorers on the plugin's `ScorerContext` / `Score` types. Import them rather
than pasting the guide's inline `mistralai.evaluations` versions — the plugin API differs (scorers
are `@evaluation.scorer`-decorated and take the plugin's `ScorerContext`, not the SDK's):

```python
from evals.scorers import (
    response_present,      # non-empty answer — a liveness floor
    keyword_coverage,      # required terms appear (whole-word, case-insensitive; reads expected_keywords)
    matches_format,        # structural check against a record's expected_format regex
    response_quality,      # LLM judge (needs MISTRAL_API_KEY)
    mean_quality,          # run-level aggregate of response_quality
    parse_rating,          # the shared judge-reply parser (re-exported from evals.judge)
)
```

The package's `__init__.py` does not re-export, so import from the submodule (`evals.scorers`,
`evals.agent`, `evals.dataset`), not `from evals import …`. LLM judges here are plugin scorers, not
the inline `client.chat.parse_async` functions the guide shows; follow the existing `response_quality`
shape in `scorers.py` when adding one.

## Install & run (overrides the guide's `pip install` + `python …/eval.py`)

The `evals` package is a member of the app's **uv workspace** (its `pyproject.toml` sets dist
`app-evals` but `module-name = "evals"`, so the import path stays `evals`). Install through the app,
never with `pip`:

```bash
mistral apps capability add evals
bun run install-all                  # syncs the uv workspace (shared .venv) + Bun workspaces
export MISTRAL_API_KEY=<your-key>
```

Runs are **worker-driven** — there is no `python evaluations/<name>/eval.py` to launch. The eval
workflows use Temporal APIs internally, so they must be dispatched to a running worker (they cannot
run inline). With `MISTRAL_API_KEY` set and a worker up:

```bash
bunx nx run evals:eval-agents     # python -m cli eval-agents → dispatches AgentEvaluationWorkflow
bunx nx run evals:eval-search     # python -m cli eval-search → dispatches SearchEvaluationWorkflow
bunx nx run evals:eval-search-corpus -- --dataset evals/gold.json   # → SearchCorpusEvaluationWorkflow
```

`eval-search` grades an offline **synthetic** corpus (hash embeddings) and never reads the app's
data: it proves the harness, not the product. To grade this app's search, run
`eval-search-corpus` against a gold set of `{"query", "relevant_sources": [<ingested source id or
fnmatch glob>]}` cases (format in `evals/search/corpus.py`). It calls `search_search` per query,
hybrid over the ingested corpus like the agent, and scores the source ranking.

Every command prints the execution id first and accepts `--no-wait`. Check `scorer_coverage` in the
printed summary before trusting an average: below 1.0 means a scorer dropped records (the per-evaluator
counts and errors are in its metadata).

`python -m cli eval-agents` passes `local=False`, so the run persists to AI Studio; pass `local=True`
in the params for offline iteration with no upload. Report the run in AI Studio
(Observability → Evaluate). To run on a cadence, the operator flips `EVAL_SCHEDULE_ENABLED` (see
`INSTALL.md`); the scheduled loop is host wiring, not a script you invoke.

## Dependencies

`evals` depends on `core` (the shared judge parser and workspace/env), `search` (retrieval-metric
computation for the search track, plus its transitive `postgres` + `bucket`), and `agents` +
`workflows` (the real agent path the harness scores and the Temporal orchestration around it). It
installs **last** (`weight` 30). It evaluates the app's real code path — the registered agent — so
the app must ship something evaluable; the default install already does (the `agents` track).
