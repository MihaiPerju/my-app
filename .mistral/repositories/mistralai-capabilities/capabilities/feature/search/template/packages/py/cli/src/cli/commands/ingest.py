"""Submit one Agentic Search reconcile (ingestion) pass to the worker, on demand.

Triggers the ``search_reconcile`` workflow, which ingests new and changed files and soft-deletes
vanished ones. Needs ``MISTRAL_API_KEY`` and a running worker/Temporal. It runs the same workflow
the ``schedules`` init step registers, once now instead of on its cadence, against the same corpus.
"""

import asyncio

import structlog
import typer
from env.ingestion import env as ingestion_env
from mistralai_capabilities.search.schemas import ReconcileRequest
from mistralai_capabilities.workflows.client import dispatch_workflow
from worker.workflows.search import SearchReconcileWorkflow

logger = structlog.get_logger("search.ingest")
app = typer.Typer()


@app.command(name="ingest", help=__doc__)
def _run(
    dry_run: bool = typer.Option(False, help="Plan and report without writing or deleting."),
    prefix: str | None = typer.Option(None, help="Object-key prefix to enumerate; omitted uses the env default."),
) -> None:
    request = ReconcileRequest(
        collection_name=ingestion_env.ingestion_collection_name,
        embed_model=ingestion_env.ingestion_embed_model,
        prefix=prefix,
        dry_run=dry_run,
    )
    asyncio.run(main(request))


async def main(request: ReconcileRequest) -> None:
    result = await dispatch_workflow(SearchReconcileWorkflow, request)
    logger.info("reconcile complete", result=result)
