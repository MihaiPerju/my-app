"""Grade the app's own search over its INGESTED corpus against a gold set.

Runs ``search_search`` (the agent's search activity, hybrid over the deployed backend) once per
gold query and scores the source ranking: recall@10, nDCG@10, MRR, plus the LLM relevance judge on
the top source. The gold set is a JSON array of ``{"query": ..., "relevant_sources": [...]}``,
where each entry is an ingested source id (the object key), exact or an fnmatch glob; see
``evals.search.corpus``. Needs ``MISTRAL_API_KEY``, a running worker and an ingested corpus
(``bunx nx run search:ingest``). Prints the execution id first; ``--no-wait`` returns after the start.
"""

import asyncio
from pathlib import Path

import typer
from evals.dispatch import submit_eval, summarize_eval_result
from evals.search import SearchCorpusEvalParams, load_gold_set
from worker.workflows.evals import SearchCorpusEvaluationWorkflow

app = typer.Typer()


@app.command(name="eval-search-corpus", help=__doc__)
def _run(
    dataset: Path = typer.Option(..., "--dataset", exists=True, dir_okay=False, help="Gold-set JSON file."),
    top_k: int = typer.Option(
        10,
        "--top-k",
        min=1,
        max=100,
        help="Chunks retrieved per query, as the agent's search sets it. Grouped by source, they can yield "
        "at most this many sources, so a value below 10 caps recall@10 (recorded on the run).",
    ),
    hybrid: bool = typer.Option(True, "--hybrid/--dense-only", help="Fuse BM25 with the dense score."),
    rerank: bool = typer.Option(False, "--rerank", help="Apply the LLM reranker before scoring."),
    system_name: str = typer.Option("corpus", "--system-name", help="Label recorded on the run."),
    wait: bool = typer.Option(True, "--wait/--no-wait", help="Follow the run to completion and print its summary."),
    local: bool = typer.Option(False, "--local", help="Do not upload the run to AI Studio."),
) -> None:
    params = SearchCorpusEvalParams(
        dataset=load_gold_set(dataset),
        top_k=top_k,
        hybrid=hybrid,
        rerank=rerank,
        system_name=system_name,
        local=local,
    )
    asyncio.run(main(params, wait=wait))


async def main(params: SearchCorpusEvalParams, *, wait: bool) -> None:
    result = await submit_eval(SearchCorpusEvaluationWorkflow, params, wait=wait, report=typer.echo)
    if wait:
        for line in summarize_eval_result(result):
            typer.echo(line)
