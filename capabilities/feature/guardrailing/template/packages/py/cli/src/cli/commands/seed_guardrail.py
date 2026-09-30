"""Seed the pgvector table used by the guardrail similarity scanner.

Thin CLI over ``guardrails.seed``; the ``guardrail`` init command (``python -m cli guardrail``) calls
the same function. Idempotent: a populated table is left untouched unless ``--force`` is passed.
"""

from pathlib import Path

import typer
from mistralai_capabilities.guardrails.seed import (
    DEFAULT_DATASET,
    DatasetNotFoundError,
    MissingApiKeyError,
    seed_guardrail_corpus,
)

app = typer.Typer()


@app.command(name="seed-guardrail", help=__doc__)
def main(
    dataset: Path = typer.Option(DEFAULT_DATASET, help="Labelled-prompt dataset to embed."),
    batch_size: int = typer.Option(100, help="Rows embedded per batch."),
    force: bool = typer.Option(False, help="Clear and re-seed a populated table."),
) -> None:
    try:
        outcome = seed_guardrail_corpus(dataset, batch_size=batch_size, force=force)
    except (MissingApiKeyError, DatasetNotFoundError) as error:
        typer.echo(str(error), err=True)
        raise typer.Exit(1) from error

    if outcome.skipped_existing:
        typer.echo(f"Table already has {outcome.skipped_existing} rows; skipping (use --force to rebuild).")
    else:
        typer.echo(f"Seeded {outcome.seeded} records. Total rows: {outcome.total_rows}")
