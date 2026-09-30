"""Submit one SYNTHETIC search retrieval-quality run to the workflows execution API.

Grades an offline synthetic corpus seeded with hash embeddings, so it checks the eval harness and
needs no ingested collection; it says nothing about this app's corpus. To grade the app's own search
over what it ingested, use ``eval-search-corpus``. Needs ``MISTRAL_API_KEY`` and a running
worker/Temporal. Prints the execution id first; ``--no-wait`` returns right after the start.
"""

import asyncio

import typer
from evals.dispatch import submit_eval, summarize_eval_result
from evals.search import SearchEvalParams
from worker.workflows.evals import SearchEvaluationWorkflow

app = typer.Typer()


@app.command(name="eval-search", help=__doc__)
def _run(
    wait: bool = typer.Option(True, "--wait/--no-wait", help="Follow the run to completion and print its summary."),
    local: bool = typer.Option(False, "--local", help="Do not upload the run to AI Studio."),
) -> None:
    asyncio.run(main(wait=wait, local=local))


async def main(*, wait: bool, local: bool) -> None:
    result = await submit_eval(SearchEvaluationWorkflow, SearchEvalParams(local=local), wait=wait, report=typer.echo)
    if wait:
        for line in summarize_eval_result(result):
            typer.echo(line)
