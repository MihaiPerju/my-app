"""The nightly feedback loop: ratings out of Studio, a curated dataset back in.

Five steps on one schedule (the ``schedules`` command): read the window's ``user_feedback``
rows, drop the unjustified, converge survivors into an AI Studio Dataset, read it back, then
replay it through the real agent and score it. The dataset is the system of record. Steps 1-4 are
activities because each is a network side effect.
"""

from datetime import timedelta
from typing import Any

import mistralai.workflows as workflows
from mistralai.workflows import workflow as _wf

with _wf.unsafe.imports_passed_through():
    from evals.feedback import build_feedback_evaluators
    from mistralai.workflows.plugins.evaluations import evaluation
    from mistralai.workflows.plugins.evaluations.types import Project, System
    from mistralai_capabilities.feedback import activities
    from mistralai_capabilities.feedback.schemas import (
        DatasetRequest,
        FeedbackBatch,
        FeedbackHarvestParams,
    )

    from worker.workflows.evals import AgentEvalTaskWorkflow


@workflows.workflow.define(
    name="feedback_harvest",
    workflow_display_name="Chat feedback harvest and evaluation",
    enforce_determinism=False,
    execution_timeout=timedelta(hours=8),
)
class FeedbackHarvestWorkflow:
    @workflows.workflow.entrypoint
    async def run(self, params: FeedbackHarvestParams) -> dict[str, Any]:
        harvested = await activities.feedback_read_ratings(params)
        if not harvested.cases:
            return {"status": "no_ratings", "harvested": 0, "kept": 0}

        kept = await activities.feedback_judge_relevance(FeedbackBatch(params=params, cases=harvested.cases))
        if not kept.cases:
            return {"status": "none_relevant", "harvested": len(harvested.cases), "kept": 0}

        dataset = await activities.feedback_write_dataset(FeedbackBatch(params=params, cases=kept.cases))
        summary: dict[str, Any] = {
            "harvested": len(harvested.cases),
            "kept": len(kept.cases),
            "dataset_id": dataset.dataset_id,
            "dataset_name": dataset.name,
            "appended": dataset.appended,
            "records": dataset.records,
        }

        # The floor is measured against what the dataset now HOLDS, not against what this run
        # contributed: a resumed run that appended two records to a dataset already holding
        # thirty is evaluating thirty-two, and gating on `appended` would skip it.
        if dataset.records < params.min_records_to_evaluate:
            return {
                **summary,
                "status": "dataset_only",
                "reason": f"fewer than {params.min_records_to_evaluate} records; evaluation would report noise",
            }

        records = await activities.feedback_dataset_records(DatasetRequest(dataset_id=dataset.dataset_id))
        result = await evaluation.run(
            dataset=records.records,
            task=AgentEvalTaskWorkflow,
            evaluators=build_feedback_evaluators(),
            system=System(name=params.system_name, params={"judge_model": params.judge_model}),
            project=Project(name=params.project_name),
            tags=["agent", "feedback", "harvested"],
            local=params.local,
        )
        return {**summary, "status": "evaluated", "evaluation": result.model_dump()}
