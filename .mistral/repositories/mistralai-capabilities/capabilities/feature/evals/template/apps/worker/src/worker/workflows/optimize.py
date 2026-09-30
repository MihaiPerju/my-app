"""GEPA over the orchestrator system prompt, scored on real user feedback.

GEPA searches for an orchestrator prompt that earns better ratings. Each candidate is a real
``Agent`` built with ``model_copy`` to keep the ``_bundle`` and subagents. The winner is a new
``candidate`` version; promotion to ``production`` is a human act.
"""

from datetime import timedelta
from typing import Any

import mistralai.workflows as workflows
from mistralai.workflows import workflow as _wf

with _wf.unsafe.imports_passed_through():
    from env.feedback import env as feedback_env
    from evals.feedback import build_feedback_evaluators
    from mistralai.workflows.plugins.evaluations import GEPA, Tunable, evaluation
    from mistralai.workflows.plugins.evaluations.types import (
        Evaluation,
        Project,
        TaskContext,
        TunableSystem,
    )
    from mistralai_capabilities.feedback import activities
    from mistralai_capabilities.feedback.schemas import (
        DatasetRequest,
        PromptOptimizationParams,
        PublishCandidateRequest,
    )

    from worker.workflows.agents import orchestrator_agent


@evaluation.task
async def optimize_agent_task(ctx: TaskContext) -> dict[str, Any]:
    """One dataset record, answered by the real agent running this candidate's prompt.

    ``model_copy`` carries the ``_bundle``, so the candidate is the whole loaded project with one
    field replaced. It returns the ``{"response": ...}`` shape ``evals.agent.task_output`` uses. A
    failed turn returns an empty answer, so a broken candidate loses points instead of aborting.
    """
    candidate = orchestrator_agent.model_copy(update={"instructions": str(ctx.system.params["instructions"])})
    result = await candidate.run(str(ctx.input_record["message"]))
    if result.stop_reason == "error":
        return {"response": ""}
    return {"response": result.text}


@workflows.workflow.define(
    name="prompt_optimization",
    workflow_display_name="Orchestrator prompt optimization (GEPA)",
    enforce_determinism=False,
    execution_timeout=timedelta(hours=12),
)
class PromptOptimizationWorkflow:
    @workflows.workflow.entrypoint
    async def run(self, params: PromptOptimizationParams) -> dict[str, Any]:
        dataset = await activities.feedback_dataset_records(
            DatasetRequest(dataset_id=params.dataset_id, name_prefix=params.dataset_name_prefix)
        )
        records = dataset.records
        if len(records) < feedback_env.feedback_min_records_to_evaluate:
            return {
                "status": "insufficient_dataset",
                "records": len(records),
                "required": feedback_env.feedback_min_records_to_evaluate,
            }

        # The registry's production prompt when this deployment sources one, otherwise what the
        # promoted agent is actually running. Either way the seed is the live prompt, which is
        # what makes the reported gain a gain over something real.
        seed = await activities.feedback_seed_prompt()
        instructions_seed = seed.content or orchestrator_agent.instructions or ""

        result = await evaluation.optimize(
            project=Project(name=params.project_name),
            evaluation=Evaluation(name="Orchestrator prompt optimization"),
            dataset=records,
            task=optimize_agent_task,
            evaluators=build_feedback_evaluators(),
            system=TunableSystem(
                name="candidate",
                params={
                    "instructions": Tunable(instructions_seed),
                    "judge_model": params.judge_model,
                },
            ),
            algo=GEPA(
                iterations=feedback_env.feedback_optimize_iterations,
                pareto_size=feedback_env.feedback_optimize_pareto_size,
                minibatch_size=feedback_env.feedback_optimize_minibatch_size,
                holdout=feedback_env.feedback_optimize_holdout,
                patience=feedback_env.feedback_optimize_patience,
                random_seed=feedback_env.feedback_optimize_random_seed,
                reflection_model=feedback_env.feedback_optimize_reflection_model,
                mutation_model=feedback_env.feedback_optimize_mutation_model,
            ),
            tags=["agent", "feedback", "optimization"],
        )

        # OptimizeResult (singular plugin 0.4, unchanged through plural 0.6) verdict: "success" sets
        # `winner`, "best_attempt" sets `best_attempt`, "no_change" sets neither. `best` is whichever
        # variant the search surfaced. It only reports the run; publishing keys off `winner` alone (see below).
        best = result.winner or result.best_attempt
        payload: dict[str, Any] = {
            "status": result.verdict,
            "algorithm": result.algorithm,
            "summary": result.summary,
            "records": len(records),
            "baseline_score": result.baseline.score,
            "optimized_score": best.score if best is not None else None,
            "improvement": best.gain if best is not None else None,
            "candidates": len(result.trajectory),
            "optimization_url": result.optimization_url,
        }
        # Auto-file only a holdout-validated, gate-passing winner. A best_attempt improved the score
        # but missed the acceptance bar, so it is reported above and never put in the promotion queue.
        # The tuned prompt lives in the winner's full System config under the "instructions" slot.
        winner = result.winner
        instructions = winner.system.get("instructions") if winner is not None else None
        if winner is None or not params.publish_candidate or not isinstance(instructions, str):
            return payload

        published = await activities.feedback_publish_candidate(
            PublishCandidateRequest(
                content=instructions,
                notes=(
                    f"GEPA {result.algorithm}: {result.baseline.score:.3f} -> {winner.score:.3f} "
                    f"({winner.gain:+.3f}) on {len(records)} records, {_wf.now().date()}"
                ),
            )
        )
        return {**payload, "published": published.model_dump(), "run_url": winner.run_url}
