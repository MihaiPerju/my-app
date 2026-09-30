"""Submit one agent evaluation run to the workflows execution API.

This triggers a run of the worker-discovered `agent_evaluation` and `agent_eval_task` workflows;
it needs `MISTRAL_API_KEY`, a running worker, and Temporal. The eval workflows are worker-only
because `evaluation.run(...)` uses Temporal APIs, so they cannot run inline via `execute_workflow`.
Prints the execution id first; `--no-wait` returns right after the start.
"""

import asyncio

import typer
from evals.agent import AgentEvalParams
from evals.dispatch import submit_eval, summarize_eval_result
from worker.workflows.evals import AgentEvaluationWorkflow

app = typer.Typer()


@app.command(name="eval-agents", help=__doc__)
def _run(
    wait: bool = typer.Option(True, "--wait/--no-wait", help="Follow the run to completion and print its summary."),
    local: bool = typer.Option(False, "--local", help="Do not upload the run to AI Studio."),
) -> None:
    asyncio.run(main(wait=wait, local=local))


async def main(*, wait: bool, local: bool) -> None:
    result = await submit_eval(AgentEvaluationWorkflow, AgentEvalParams(local=local), wait=wait, report=typer.echo)
    if wait:
        for line in summarize_eval_result(result):
            typer.echo(line)
