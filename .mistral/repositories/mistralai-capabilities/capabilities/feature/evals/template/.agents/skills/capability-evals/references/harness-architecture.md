# harness-architecture — what the shipped `evals` harness already does and how it is wired

The methodology in `SKILL.md` is the entry behaviour; this reference answers a different
question — **what does this app already ship, and how is it put together** — so you extend the
existing harness instead of rebuilding it. Read this when a run already exists and you are adding
a scorer, a dataset case, or a track, or working the feedback→GEPA loop.

Two evaluation halves, shipped as two Python packages coupled only by the shared judge parser (`evals.judge`).
`packages/py/evals` is an **offline harness**: scorers, datasets and evaluator wiring you run
against the real agent on demand. `mistralai_capabilities.feedback` is the **`feedback`
feature** — the activities and schemas of a schedule-driven loop that harvests chat ratings into a
Dataset and files a GEPA prompt candidate. Depends on `evals` (the shared judge parser) and `search`
(retrieval-metric computation).

This capability owns the *what and how of scoring* only. The Temporal orchestration around it —
`workflows/{evals,feedback,optimize}.py`, `env/{evals,feedback}.py`, schedule registration, and eval
targets — belongs to the corresponding workflow and tooling capabilities. It does **not** own search
retrieval mechanics (`search/retrieval_quality.py`) or ratings emission (the chat feedback event).

## What it ships

| Path | Role |
| --- | --- |
| `packages/py/evals/src/evals/scorers.py` | Every scorer for both tracks: deterministic (`response_present`, `keyword_coverage`), LLM-judge (`response_quality`), IR-metric readers (`search_recall_at_10`, …), and the run-level aggregators. |
| `packages/py/evals/src/evals/agent.py` | Agent-track eval config: `AgentEvalParams`, evaluator/goal wiring, `task_message`/`task_output` helpers. |
| `packages/py/evals/src/evals/search/` | Search-track config (`evaluators.py`) and the Mistral relevance judge (`relevance.py` + its system prompt `label_result_prompt.txt`). |
| `packages/py/evals/src/evals/dataset.py` + `data/*.json` | Loaders that read the two seed datasets from JSON. |
| `packages/py/evals/src/evals/feedback.py` | Evaluator wiring for a **replay** of harvested feedback cases; adds `improved_on_feedback`. |
| `packages/py/evals/tests/` | Four keyless test modules (the LLM judge is faked). |
| `packages/py/cli/src/cli/commands/eval_agents.py` | Dispatches `AgentEvaluationWorkflow` to the worker with `local=False` (`python -m cli eval-agents`). |
| `…/mistralai_capabilities/feedback/{activities,schemas}.py` | The feedback loop: six network activities, plus the pure loop-boundary schemas and case-building logic. |

## The two halves differ in who runs them

The harness is something you invoke: `bunx nx run evals:eval-agents` / `bunx nx run evals:eval-search` dispatch
`AgentEvaluationWorkflow` / `SearchEvaluationWorkflow` to the worker (`local=False` uploads to AI
Studio; pass `local=True` in the params for offline iteration with no upload). The feedback loop is
something the worker runs itself, on the cron `env/feedback.py` declares, and off by default — the
harvest is gated **twice** (`FEEDBACK_HARVEST_ENABLED` **and** the observability read flag), because
a nightly read against an endpoint the workspace has no grant for is a pager, not a feature.

## A scorer is a function; an evaluator binds it to a goal

`@evaluation.scorer` grades one record; `@evaluation.run_scorer` aggregates a whole run. A scorer
only runs when an `Evaluator` (per-record) or `RunEvaluator` (run-level) names it with a `Goal`
threshold, built in `agent.py` / `search/evaluators.py`. To add one: write the scorer in
`scorers.py`, add it to `__all__`, then wire an `Evaluator(name=…, scorer=…, goal=Goal.gte(…))` in
the track's `build_*` function. Deterministic scorers make no model call; `response_quality` and
`search_llm_relevance` do, so they need `MISTRAL_API_KEY`.

## Shared evaluators are the same object, not copies

`response_present_evaluator()` and `response_quality_evaluator()` are factories the agent track and
the feedback replay both call, so a nightly run and a harvested-feedback run report the same metric
under the same name and goal and stay comparable in Studio. `test_feedback.py` asserts
`feedback[name].scorer is nightly[name].scorer` — re-declaring an evaluator would let the two drift
the first time someone retunes a goal. `parse_rating` is likewise re-exported from `evals.judge` so
the quality judge and the feedback relevance judge cannot land on different scales.

## Add a dataset case by editing JSON, not Python

`agent_eval.json` records are `{message, expected_keywords, expected}` — one turn each; `message` is
the input, `expected_keywords` drives `keyword_coverage`, `expected` guides the LLM judge.
`search_retrieval_eval.json` records are `{query, relevant_reference_ids}`, where the ids are
`page_number_*` proxies into the synthetic corpus. `dataset.py` loads both from
`importlib.resources`, so a new case is a JSON edit with no code change. `test_search_scorers.py`
pins the search dataset shape (every record has a non-empty query and gold ids).

## The search track scores metrics it does not compute

`search/evaluators.py` and the `search_*` scorers only *read* IR metrics (`recall@10`, `ndcg@10`,
`mrr`) out of the task output dict; the retrieval and metric computation happen in `search`'s
`search/retrieval_quality.score_and_probe`, called by `SearchEvaluationWorkflow` in the host.
This capability adds one thing on top: a Mistral relevance judge, `relevance.py`, which scores a
retrieved page 0-5. It is the `label_result` judge of the retired `mistralai-search-quality` library,
vendored with its prompt, models and parse-and-retry loop unchanged and run on Mistral's
structured-output chat API. That judge is **un-grounded** (no `google_search` equivalent), so treat
absolute scores as directional and use them for A/B deltas — not ground truth.

## The feedback loop couples to the harness through three field names

Beyond the shared judge parser (`evals.judge.parse_rating`), `mistralai_capabilities.feedback` and
`evals` stay decoupled: the only data contract between them is three keys on a dataset record — `message`, `rating`, `prior_answer` — written by
`FeedbackCase.dataset_payload()` and read by `evals.agent.task_message` and
`evals.feedback.improved_on_feedback`. That shape is chosen so the **existing**
`AgentEvalTaskWorkflow` can replay a harvested dataset unchanged. `improved_on_feedback` is a change
detector, not a quality measure: on a thumbs-down case a *different* bad answer scores 1.0. Read it
beside `response_quality`, never instead of it — `test_feedback.py` exists because it is easy to
misread as a quality signal and "fix".

## A rating is cheap to collect and expensive to trust

`schemas.py` holds the pure filter that turns raw votes into evaluable cases: it reconstructs the
exchange each rating judged (last user + last assistant message off the span) and drops any case it
cannot rebuild. `activities.feedback_judge_relevance` then scores whether the exchange *justifies*
the rating and keeps only those clearing `relevance_threshold` — importing raw votes would teach the
optimizer to chase whatever produced the loudest reaction. `feedback_write_dataset` is
**idempotent**: the window's Dataset is addressed by name (`<prefix>-YYYY-MM-DD`), and each case is
appended only when its `span_id` is not already filed, so a resumed run converges, never doubles.

## The loop produces a candidate, never a promotion

The two artefacts are an AI Studio **Dataset** per window and a registry **prompt version** under
the `candidate` alias. `optimize.py`'s GEPA search optimizes the real agent (a `model_copy` that
keeps the folder harness and all subagents), seeds generation 0 from the *live* production prompt,
and files the winner — but `feedback_publish_candidate` **never touches `production`**; promotion
stays a human act. GEPA also cannot run `local` (per-candidate scoring reads runs back from Studio
to build the Pareto frontier), and reads the installed plugin's
`baseline`/`optimized`/`improvement`/`improved` result model, not the `verdict`/`winner` shape the
published guide documents.

## The dist rename is load-bearing

`packages/py/evals/pyproject.toml` names the dist `app-evals` so it cannot collide with the `evals`
**capability** dist (which is `mistralai_capabilities.feedback`), while
`module-name = "evals"` keeps the import path `evals` so no app code changes. This is also why the
two halves sit in different packages at all: the harness is a plain workspace package; the feedback
feature ships under the `mistralai_capabilities` PEP-420 namespace like every other capability toolkit.

## Where to read next

`packages/py/evals/README.md` documents the agent track and its run commands; read here for what
spans both halves. For host wiring, see the `capability-workflows` skill and the owning feature skill.
