"""Seed the similarity scanner's pgvector corpus.

Skipped unless the gate and its similarity scanner are both enabled, so a deployment that
runs the guardrail with only the LLM and moderation scanners needs no API key at init
time. Seeding itself is idempotent.
"""

import structlog
import typer
from env.guardrail import env as guardrail_env
from mistralai_capabilities.guardrails.seed import seed_guardrail_corpus

logger = structlog.get_logger("init.guardrail")
app = typer.Typer()
INIT_STEP = True  # wired into the deployment init chain (compose services + Helm Jobs)


@app.command(name="guardrail", help=__doc__)
def main() -> None:
    if not (guardrail_env.guardrail_enabled and guardrail_env.guardrail_similarity_enabled):
        logger.info("guardrail seeding skipped", reason="similarity scanner disabled")
        return
    outcome = seed_guardrail_corpus()
    logger.info(
        "guardrail corpus seeded",
        seeded=outcome.seeded,
        skipped_existing=outcome.skipped_existing,
        total_rows=outcome.total_rows,
    )
