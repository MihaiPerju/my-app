"""Agent and search end-to-end evaluation workflows, discoverable on the worker.

Each track has a task workflow (one record) and a runner workflow that fans the dataset through
``evaluation.run`` and scores it. Search has two tracks: ``search_evaluation`` grades an offline
synthetic corpus (hash embeddings, no key, CI-safe) and never touches the app's data;
``search_corpus_evaluation`` runs ``search_search`` over the ingested corpus against a gold set.
None is exposed over HTTP; no router mounts them, so they run on the worker only, triggered by name
or ``execute_workflow``. Eval config (params, evaluator
wiring, task helpers) lives in the standalone ``evals`` package. This module is pure Temporal
orchestration.
"""

from collections.abc import Awaitable
from datetime import timedelta
from typing import Any, cast

import mistralai.workflows as workflows
from mistralai.workflows import workflow as _wf

with _wf.unsafe.imports_passed_through():
    from env.workflows import env as workflows_env
    from evals.agent import (
        AgentEvalParams,
        build_evaluators,
        build_run_evaluators,
        task_message,
        task_output,
    )
    from evals.dataset import DEFAULT_DATASET, SEARCH_RETRIEVAL_DATASET
    from evals.search import (
        SearchCorpusEvalParams,
        SearchEvalParams,
        build_search_evaluators,
        build_search_run_evaluators,
        corpus_search_request,
        corpus_task_output,
        search_record,
        validate_gold_set,
    )
    from mistralai.workflows.plugins.evaluations import evaluation
    from mistralai.workflows.plugins.evaluations.types import System
    from mistralai_capabilities.search.activities import search_search
    from mistralai_capabilities.search.retrieval_quality import score_and_probe
    from mistralai_capabilities.search.schemas import CorpusSearchResult

    from worker.workflows.agents import orchestrator_agent


@workflows.activity(
    name="agent_eval_run",
    start_to_close_timeout=timedelta(hours=1),
    # The orchestrator can call mutating tools and connectors; a retry would rerun the prompt and
    # could repeat an external action, so this takes the single-attempt mutation policy.
    retry_policy_max_attempts=workflows_env.activity_mutation_retry_max_attempts,
    retry_policy_backoff_coefficient=workflows_env.activity_retry_backoff_coefficient,
)
async def run_orchestrator_to_completion(prompt: str) -> str:
    """Run the real orchestrator agent to completion behind a durable activity boundary.

    ``Agent.run()`` performs model, tool, and connector I/O; a replayable workflow entrypoint cannot
    host it, because a worker replay would repeat those external effects (``enforce_determinism=False``
    only disables the determinism check, it does not make the effects durable). Recording the run as an
    activity means the eval scores the registered agent once and a replay reuses the recorded answer.
    """
    result = await orchestrator_agent.run(prompt)
    return result.text


@workflows.workflow.define(
    name="agent_eval_task",
    workflow_display_name="Agent eval task",
    enforce_determinism=False,
    execution_timeout=timedelta(hours=1),
)
class AgentEvalTaskWorkflow:
    @workflows.workflow.entrypoint
    async def run(self, params: dict[str, Any]) -> dict[str, Any]:
        # Score the registered orchestrator; the run itself is the durable activity above, so a
        # workflow replay is side-effect-free.
        return task_output(await run_orchestrator_to_completion(task_message(params)))


@workflows.workflow.define(
    name="agent_evaluation",
    workflow_display_name="Agent evaluation",
    enforce_determinism=False,
    execution_timeout=timedelta(hours=8),
)
class AgentEvaluationWorkflow:
    @workflows.workflow.entrypoint
    async def run(self, params: AgentEvalParams) -> dict[str, Any]:
        result = await evaluation.run(
            dataset=params.dataset or DEFAULT_DATASET,
            task=AgentEvalTaskWorkflow,
            evaluators=build_evaluators(),
            run_evaluators=build_run_evaluators(),
            system=System(name=params.system_name, params={"judge_model": params.judge_model}),
            tags=["agent", "e2e"],
            local=params.local,
        )
        return result.model_dump()


@workflows.workflow.define(
    name="search_eval_task",
    workflow_display_name="Search retrieval eval task",
    enforce_determinism=False,
    execution_timeout=timedelta(hours=1),
)
class SearchEvalTaskWorkflow:
    @workflows.workflow.entrypoint
    async def run(self, params: dict[str, Any]) -> dict[str, Any]:
        query, gold, collection = search_record(params)
        metrics, page = await score_and_probe(query, gold, collection=collection)
        return {"query": query, "metrics": metrics, "page": page}


@workflows.workflow.define(
    name="search_evaluation",
    workflow_display_name="Search retrieval evaluation",
    enforce_determinism=False,
    execution_timeout=timedelta(hours=8),
)
class SearchEvaluationWorkflow:
    @workflows.workflow.entrypoint
    async def run(self, params: SearchEvalParams) -> dict[str, Any]:
        result = await evaluation.run(
            dataset=params.dataset or SEARCH_RETRIEVAL_DATASET,
            task=SearchEvalTaskWorkflow,
            evaluators=build_search_evaluators(),
            run_evaluators=build_search_run_evaluators(),
            system=System(name=params.system_name, params={"judge_model": params.judge_model}),
            tags=["search", "retrieval", "ir"],
            local=params.local,
        )
        return result.model_dump()


@workflows.workflow.define(
    name="search_corpus_eval_task",
    workflow_display_name="Corpus search eval task",
    enforce_determinism=False,
    execution_timeout=timedelta(minutes=15),
)
class SearchCorpusEvalTaskWorkflow:
    @workflows.workflow.entrypoint
    async def run(self, params: dict[str, Any]) -> dict[str, Any]:
        case, request = corpus_search_request(params)
        # The activity the agent calls, against the ingested corpus: this is the ranking the
        # product serves. `@agents.tool` over `@workflows.activity` types the call as
        # `T | Awaitable[T]`; inside a workflow it is always the awaitable activity handle.
        result = await cast("Awaitable[CorpusSearchResult]", search_search(request))
        return corpus_task_output(case, result)


@workflows.workflow.define(
    name="search_corpus_evaluation",
    workflow_display_name="Corpus search evaluation",
    enforce_determinism=False,
    execution_timeout=timedelta(hours=8),
)
class SearchCorpusEvaluationWorkflow:
    """Grade the app's own search over its ingested corpus against a gold set (``evals.search.corpus``)."""

    @workflows.workflow.entrypoint
    async def run(self, params: SearchCorpusEvalParams) -> dict[str, Any]:
        result = await evaluation.run(
            dataset=validate_gold_set(params.dataset),
            task=SearchCorpusEvalTaskWorkflow,
            evaluators=build_search_evaluators(),
            run_evaluators=build_search_run_evaluators(),
            system=params.system(),
            tags=["search", "retrieval", "ir", "corpus"],
            local=params.local,
        )
        return result.model_dump()
