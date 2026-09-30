import pytest
from evals import scorers
from evals.agent import AgentEvalParams, build_evaluators, task_message, task_output
from evals.dataset import DEFAULT_DATASET
from evals.search import SearchEvalParams, build_search_evaluators, search_record
from mistralai.workflows import get_workflow_definition
from mistralai_capabilities.feedback.schemas import FeedbackHarvestParams, PromptOptimizationParams
from worker.workflows.tooling import create_workflow_tools


def test_evaluation_workflows_have_stable_names() -> None:
    from worker.workflows.evals import (
        AgentEvalTaskWorkflow,
        AgentEvaluationWorkflow,
        SearchEvalTaskWorkflow,
        SearchEvaluationWorkflow,
    )
    from worker.workflows.feedback import FeedbackHarvestWorkflow
    from worker.workflows.optimize import PromptOptimizationWorkflow

    assert {
        get_workflow_definition(cls).name
        for cls in (
            AgentEvaluationWorkflow,
            AgentEvalTaskWorkflow,
            SearchEvaluationWorkflow,
            SearchEvalTaskWorkflow,
            FeedbackHarvestWorkflow,
            PromptOptimizationWorkflow,
        )
    } == {
        "agent_evaluation",
        "agent_eval_task",
        "search_evaluation",
        "search_eval_task",
        "feedback_harvest",
        "prompt_optimization",
    }


def test_evaluation_workflow_tools_use_their_request_schemas() -> None:
    from worker.workflows.evals import AgentEvaluationWorkflow, SearchEvaluationWorkflow
    from worker.workflows.feedback import FeedbackHarvestWorkflow
    from worker.workflows.optimize import PromptOptimizationWorkflow

    tools = {
        tool.name: tool
        for tool in create_workflow_tools(
            (
                AgentEvaluationWorkflow,
                SearchEvaluationWorkflow,
                FeedbackHarvestWorkflow,
                PromptOptimizationWorkflow,
            )
        )
    }

    assert tools["agent_evaluation"].input_schema is AgentEvalParams
    assert tools["search_evaluation"].input_schema is SearchEvalParams
    assert tools["feedback_harvest"].input_schema is FeedbackHarvestParams
    assert tools["prompt_optimization"].input_schema is PromptOptimizationParams


def test_search_default_params() -> None:
    params = SearchEvalParams()
    assert params.local is True
    assert params.judge_model == "mistral-small-latest"
    assert params.dataset == []


def test_search_evaluators_cover_expected_scorers() -> None:
    evaluators = build_search_evaluators()
    assert {e.name for e in evaluators} == {
        "search_recall_at_10",
        "search_ndcg_at_10",
        "search_mrr",
        "search_llm_relevance",
    }
    assert all(e.goal is not None for e in evaluators)


def test_corpus_search_workflows_have_stable_names() -> None:
    from worker.workflows.evals import SearchCorpusEvalTaskWorkflow, SearchCorpusEvaluationWorkflow

    assert get_workflow_definition(SearchCorpusEvaluationWorkflow).name == "search_corpus_evaluation"
    assert get_workflow_definition(SearchCorpusEvalTaskWorkflow).name == "search_corpus_eval_task"


async def test_corpus_eval_task_scores_the_real_search_ranking(monkeypatch: pytest.MonkeyPatch) -> None:
    """The corpus track must grade what `search_search` returns, not a seeded synthetic store."""
    from mistralai_capabilities.search.schemas import CorpusSearchResult, SearchRequest, SourceGroup
    from worker.workflows import evals as evals_workflows

    seen: list[SearchRequest] = []

    async def fake_search(request: SearchRequest) -> CorpusSearchResult:
        seen.append(request)
        groups = [SourceGroup(source_id="kb/other.md"), SourceGroup(source_id="kb/gold.md", title="Gold")]
        return CorpusSearchResult(
            query=request.query,
            collection_name=request.collection_name,
            groups=groups,
            atom_count=0,
            group_count=2,
            reranked=False,
        )

    monkeypatch.setattr(evals_workflows, "search_search", fake_search)
    raw = await evals_workflows.SearchCorpusEvalTaskWorkflow().run(
        {
            "params": {
                "input_record": {"query": "where is gold", "relevant_sources": ["kb/gold.md"]},
                "system": {"name": "corpus", "params": {"top_k": 7, "hybrid": True, "rerank": False}},
                "metadata": {},
            }
        }
    )
    output = raw.get("result", raw)
    assert seen[0].query == "where is gold"
    assert seen[0].top_k == 7
    assert seen[0].hybrid is True
    assert output["ranked_sources"] == ["kb/other.md", "kb/gold.md"]
    assert output["metrics"]["recall@10"] == 1.0
    assert output["metrics"]["mrr"] == 0.5
    assert output["page"]["url"] == "source://kb/other.md"


def test_every_track_reports_scorer_coverage() -> None:
    from evals.agent import build_run_evaluators
    from evals.search import build_search_run_evaluators

    for run_evaluators in (build_run_evaluators(), build_search_run_evaluators()):
        assert "scorer_coverage" in {e.name for e in run_evaluators}


def test_search_record_extracts_query_and_gold() -> None:
    params = {
        "input_record": {"query": "q", "relevant_reference_ids": ["page_number_12"], "collection": "c"},
        "system": None,
        "metadata": {},
    }
    assert search_record(params) == ("q", ["page_number_12"], "c")


def test_default_params() -> None:
    params = AgentEvalParams()
    assert params.local is True
    assert params.judge_model == "mistral-small-latest"
    assert params.dataset == []


def test_evaluators_cover_expected_scorers() -> None:
    evaluators = build_evaluators()
    assert {e.name for e in evaluators} == {"response_present", "keyword_coverage", "response_quality"}
    by_name = {e.name: e for e in evaluators}
    assert by_name["response_present"].scorer is scorers.response_present
    assert by_name["response_quality"].scorer is scorers.response_quality
    assert all(e.goal is not None for e in evaluators)


def test_seed_dataset_shape() -> None:
    assert len(DEFAULT_DATASET) >= 1
    assert all("message" in case and case["message"] for case in DEFAULT_DATASET)


def test_task_message_extracts_from_task_context() -> None:
    params = {"input_record": {"message": "hello agent"}, "system": None, "metadata": {}}
    assert task_message(params) == "hello agent"


def test_task_output_shapes_result() -> None:
    assert task_output("hi") == {"response": "hi"}


async def test_agent_eval_task_answers_from_the_orchestrator_run(monkeypatch: pytest.MonkeyPatch) -> None:
    """The agent-eval task drives the real orchestrator through `.run()` and shapes `{response: ...}`.

    This is the run-based replacement for the removed `type="chat"` child workflow: the task scores
    whatever `orchestrator_agent.run(...)` returns, not a parallel eval-only path.
    """
    from worker.workflows import evals as evals_workflows

    prompts: list[str] = []

    class _Result:
        text = "the orchestrator answer"

    class _Agent:
        async def run(self, content: str) -> _Result:
            prompts.append(content)
            return _Result()

    monkeypatch.setattr(evals_workflows, "orchestrator_agent", _Agent())

    raw = await evals_workflows.AgentEvalTaskWorkflow().run(
        {"params": {"input_record": {"message": "hello agent"}, "system": None, "metadata": {}}}
    )

    # run(...) returns the SDK's {"result": <task output>} wrapping; the task output is the contract.
    assert raw.get("result", raw) == {"response": "the orchestrator answer"}
    assert prompts == ["hello agent"]
