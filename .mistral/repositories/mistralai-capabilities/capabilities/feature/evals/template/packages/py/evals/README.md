# evals

End-to-end evaluation of the conversational agent, built on the Workflow Evaluation Plugin
(`mistralai-workflows-plugins-evaluations`).

It runs each dataset case through the **real agent** — the same orchestrator the production `agents`
session workflow serves, via `orchestrator_agent.run(...)` — and scores the answers.

## Layout (follows the repo's feature layering)

- **Workflows** (discoverable): `apps/worker/src/worker/workflows/evals.py`
  - `AgentEvalTaskWorkflow` — workflow-as-task; runs one real agent turn per case by calling
    `orchestrator_agent.run(...)`, so it scores the registered agent.
  - `AgentEvaluationWorkflow` — fans the dataset out through `evaluation.run(...)` and scores it.
  - Both are picked up by `discover_all_workflows_in_package("worker.workflows")` and run on the worker.
    Neither has a route module, so they add **no `/api` route and no MCP tool** (they are worker-only;
    trigger by name / `execute_workflow`).
- **Activities + data** (this package): `scorers.py`, `dataset.py`.
  - Deterministic `response_present` / `keyword_coverage`, LLM-judge `response_quality`, run-level
    `mean_quality`; `Goal` thresholds gate pass/fail. `DEFAULT_DATASET` seeds one case per route.

## Run it

The worker already discovers these workflows; the plugin auto-registers its `eval-record` and
`eval-generation` child workflows and interceptor at startup. With `MISTRAL_API_KEY` set and a worker running:

```bash
bunx nx run evals:eval-agents      # submits agent_evaluation ad hoc (local=False → uploads to AI Studio)
```

`python -m cli eval-agents` passes `local=False`, so the run is persisted to AI Studio; pass `local=True`
in `AgentEvalParams` for offline iteration with no upload. Tune the `Goal` thresholds in
`evals.agent.build_evaluators()` to gate on regressions.

Every `eval-*` command prints the execution id as soon as the run starts. `--no-wait` returns right
there; otherwise it polls to completion (retrying dropped connections) and prints each evaluator's
average next to the number of records it actually scored, plus `scorer_coverage`: the lowest share
of records any evaluator scored. Below 1.0, some averages cover only the records that survived.

## Search: synthetic vs corpus

- `bunx nx run evals:eval-search` grades an **offline synthetic** corpus seeded with hash embeddings.
  It needs no ingestion and runs in CI, but it never reads this app's data.
- `bunx nx run evals:eval-search-corpus -- --dataset evals/gold.json` grades **this app's search**:
  it calls `search_search` (hybrid over the ingested corpus, like the agent) per gold query and scores
  the source ranking with recall@10, nDCG@10, MRR and the relevance judge on the top source. Flags:
  `--top-k`, `--dense-only`, `--rerank`, `--system-name`, `--local`, `--no-wait`.

The gold set is a JSON array, one case per query:

```json
[
  {
    "query": "How long do we keep payroll records?",
    "relevant_sources": ["policies/retention.md"]
  },
  {
    "query": "parental leave",
    "relevant_sources": ["hr/leave-*.md"],
    "notes": "ignored by scorers"
  }
]
```

`relevant_sources` are ingested source ids, i.e. the object keys `search:ingest` indexed (the
`source_id` column of `search_sources`). An entry matches one source exactly, or several through an
fnmatch glob. Aim for 20 or more real user questions per corpus.

To run it on a cadence instead, set `EVAL_SCHEDULE_ENABLED=1`; the deployment `schedules` step
(`python -m cli schedules`) registers the schedule, run once before the workloads roll.

## Tests

`bunx nx run testing:test` covers `test_evals_scorers.py` (mistralai-capabilities) and
`test_feature_evals.py` (workflows) — deterministic, keyless (the LLM judge is faked). The full
Temporal run is a live op via `bunx nx run evals:eval-agents`.
