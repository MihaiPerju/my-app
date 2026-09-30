"""Converge the platform recurring workflow schedules to this declaration.

This is applied from the init one-shot, not the worker, because worker-side registration reads
schedules once at startup and every replica registers its own copy. Enabled entries are upserted;
disabled entries are paused. Pausing is not reversible here: no update model carries ``paused``,
so re-enabling a flag updates the cadence but leaves it paused.
"""

import asyncio
from typing import Any

import structlog
import typer
from env.evals import env as evals_env
from env.feedback import env as feedback_env
from env.ingestion import env as ingestion_env
from env.workflows import env as workflows_env
from evals.agent import AgentEvalParams
from mistralai.client.errors import MistralError
from mistralai_capabilities.feedback.schemas import FeedbackHarvestParams, PromptOptimizationParams
from mistralai_capabilities.workflows.client import pause_schedule_if_present, upsert_schedule

logger = structlog.get_logger("init.schedules")
app = typer.Typer()
INIT_STEP = True  # wired into the deployment init chain (compose services + Helm Jobs)

# The worker registers its workflows a few seconds after its container starts. This step runs
# once the worker is up (see deploy/compose/compose.init.yaml), but registration can lag the
# container start; until it completes the platform 404s the schedule create. Retry across that
# window instead of failing the whole init.
_REGISTRATION_RETRY_ATTEMPTS = 9
_REGISTRATION_RETRY_SECONDS = 10.0


async def _converge(
    *,
    schedule_id: str,
    workflow_identifier: str,
    enabled: bool,
    input: dict[str, Any],
    interval_seconds: int | None = None,
    cron_expressions: list[str] | None = None,
    pause_on_failure: bool = False,
) -> None:
    if not enabled:
        was_present = await pause_schedule_if_present(schedule_id=schedule_id, note="disabled by init")
        logger.info("schedule disabled", schedule_id=schedule_id, was_present=was_present)
        return

    for attempt in range(1, _REGISTRATION_RETRY_ATTEMPTS + 1):
        try:
            await upsert_schedule(
                schedule_id=schedule_id,
                workflow_identifier=workflow_identifier,
                input=input,
                interval_seconds=interval_seconds,
                cron_expressions=cron_expressions,
                pause_on_failure=pause_on_failure,
                deployment_name=workflows_env.deployment_name,
            )
            break
        except MistralError as error:
            if getattr(error, "status_code", None) != 404 or attempt == _REGISTRATION_RETRY_ATTEMPTS:
                raise
            logger.info(
                "workflow not registered yet; waiting for the worker",
                schedule_id=schedule_id,
                workflow=workflow_identifier,
                attempt=attempt,
            )
            await asyncio.sleep(_REGISTRATION_RETRY_SECONDS)
    logger.info(
        "schedule registered",
        schedule_id=schedule_id,
        workflow=workflow_identifier,
        cron=cron_expressions,
        interval_seconds=interval_seconds,
        pause_on_failure=pause_on_failure,
    )


@app.command(name="schedules", help=__doc__)
def _run() -> None:
    asyncio.run(main())


async def main() -> None:
    ingestion_cron = ingestion_env.ingestion_cron.strip()
    await _converge(
        schedule_id=ingestion_env.ingestion_schedule_id,
        workflow_identifier="search_reconcile",
        enabled=ingestion_env.ingestion_enabled,
        input={
            "collection_name": ingestion_env.ingestion_collection_name,
            "embed_model": ingestion_env.ingestion_embed_model,
        },
        interval_seconds=None if ingestion_cron else ingestion_env.ingestion_interval_seconds,
        cron_expressions=[ingestion_cron] if ingestion_cron else None,
    )
    await _converge(
        schedule_id=evals_env.eval_schedule_id,
        workflow_identifier="agent_evaluation",
        enabled=evals_env.eval_schedule_enabled,
        input=AgentEvalParams(local=evals_env.eval_local, system_name=evals_env.eval_system_name).model_dump(),
        cron_expressions=[evals_env.eval_cron],
        # Every run drives the real agent plus an LLM judge, so a broken eval must stop
        # rather than bill for the same failure once a day until someone notices.
        pause_on_failure=True,
    )
    await _converge(
        schedule_id=feedback_env.feedback_harvest_schedule_id,
        workflow_identifier="feedback_harvest",
        enabled=feedback_env.feedback_harvest_enabled,
        input=FeedbackHarvestParams(
            window_hours=feedback_env.feedback_harvest_window_hours,
            evaluation_name=feedback_env.feedback_evaluation_name,
            judge_model=feedback_env.feedback_judge_model,
            relevance_threshold=feedback_env.feedback_relevance_threshold,
            min_records_to_evaluate=feedback_env.feedback_min_records_to_evaluate,
            dataset_name_prefix=feedback_env.feedback_dataset_name_prefix,
            project_name=feedback_env.feedback_project_name,
            local=evals_env.eval_local,
        ).model_dump(),
        cron_expressions=[feedback_env.feedback_harvest_cron],
        # Reads Studio, judges every rating with an LLM, then replays the survivors through the
        # real agent. Same reasoning as the eval above, plus one of its own: the read endpoints
        # are feature-flagged, so a workspace without the grant would fail identically every
        # night forever.
        pause_on_failure=True,
    )
    await _converge(
        schedule_id=feedback_env.feedback_optimize_schedule_id,
        workflow_identifier="prompt_optimization",
        enabled=feedback_env.feedback_optimize_enabled,
        input=PromptOptimizationParams(
            dataset_name_prefix=feedback_env.feedback_dataset_name_prefix,
            project_name=feedback_env.feedback_project_name,
            judge_model=feedback_env.feedback_judge_model,
        ).model_dump(),
        cron_expressions=[feedback_env.feedback_optimize_cron],
        # The most expensive thing on a timer here: GEPA runs the real agent
        # `iterations x dataset` times. A broken search must not repeat weekly.
        pause_on_failure=True,
    )
