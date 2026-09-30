---
name: capability-evals
description: The app's evaluation harness — two worker-driven tracks (agent + search) of deterministic and LLM-judge scorers, seed datasets, and evaluator goals on the Workflow Evaluation Plugin, plus the schedule-driven feedback→GEPA loop that harvests chat ratings into a candidate prompt. Use when adding a scorer or dataset case, calibrating a judge or setting a goal, running or triaging a track, catching quality regressions, or working the feedback/optimize loop.
---

# Evals

The app's evaluation harness plus its self-improvement loop: two on-demand, worker-driven tracks — the conversational **agent** track and the retrieval **search** track — and a schedule-driven **feedback→GEPA loop** that turns chat ratings into a curated dataset and an optimized-prompt candidate. Owns the *what and how of scoring*: scorers, seed datasets, evaluator-to-goal wiring, LLM judges. Does **not** compute search retrieval/IR metrics (reads `search`'s `studio.search.retrieval_quality`), emit the chat ratings it harvests, or promote a prompt (GEPA files a `candidate`; moving to `production` is human). Deps: `core`, `search`, `agents`, `workflows`, `observability`; installs last. Read `references/app-conventions.md` (paths, package layout, run commands) first, then `references/harness-architecture.md`.

## Where things live

| Path | What |
| --- | --- |
| `packages/py/evals/` | Offline harness (workspace pkg `evals`): scorers + aggregators (`scorers.py`), agent track (`agent.py`), search track (`search/` — Mistral quality provider + relevance judge), datasets (`dataset.py` + `data/*.json`), feedback replay (`feedback.py`), judge parser (`judge.py`), tests. |
| `apps/worker/src/worker/workflows/{evals,feedback,optimize}.py` | Temporal orchestration: agent/search eval workflows, nightly `FeedbackHarvestWorkflow`, GEPA `PromptOptimizationWorkflow`. Worker-discovered; triggered by name/schedule, no HTTP route or MCP tool. |
| `mistralai_capabilities.feedback` | Installed toolkit (`mistralai-capabilities-feature-evals`): feedback slice — network `activities.py` + pure `schemas.py`. |
| `packages/py/env/src/env/{evals,feedback}.py` | Typed settings gating scheduled runs (flags default off). |
| `packages/py/cli/src/cli/commands/schedules.py` | Init one-shot (`python -m cli schedules`) converges platform schedules + the shared `search_reconcile` ingestion schedule. |
| `packages/py/cli/src/cli/commands/eval_agents.py` · `packages/py/cli/src/cli/commands/eval_search.py` | On-demand dispatch (`python -m cli eval-agents` / `eval-search`; `bunx nx run evals:eval-agents` / `evals:eval-search`). |

## Extend

You almost always extend the shipped harness, not scaffold. `ls packages/py/evals/src/evals/`, then load the phase reference:

| To do this | Load |
| --- | --- |
| Grow or repair the dataset (#1 quality lever) | `references/dataset.md` |
| Add a scorer, calibrate a judge, or set a goal | `references/evaluators.md` |
| Run a track and triage results | `references/run.md` |
| Optimize a prompt once scores plateau (opt-in) | `references/optimize.md` |
| Scope a genuinely new bespoke eval | `references/scope.md` → `references/bootstrap.md` |

Runs are **worker-driven**: `bunx nx run evals:eval-agents` / `evals:eval-search` (needs `MISTRAL_API_KEY`) — never launch `python …/eval.py`. One-off eval the two tracks miss → scaffold `evaluations/<name>/` beside the app: `eval_spec.md`, `eval.py` (module-level `dataset`/`task`/`evaluators` + `main()`), `calibrate.py`.

## Gotchas

- Name the one-off container `evaluations/`, never `evals`, and add no `__init__.py` — either shadows the shipped `evals` package and breaks every `from evals.… import`.
- Never invent scores: a confident number over three records is noise — calibrate judges, and when a run reveals a blind spot add a control before trusting scores.
