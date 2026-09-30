"""Bootstrap the configured RBAC admins.

Runs from the deployment init chain after migrations (the ``rbac_*`` tables must exist), so a fresh
deployment has its ``CUSTOM_RBAC_BOOTSTRAP_ADMINS`` as admins with no manual step, and a bootstrap admin who
was demoted is restored on the next run (self-heal). Idempotent. With ``CUSTOM_RBAC_BOOTSTRAP_ADMINS`` empty
it changes nothing, but warns when no admin exists at all (nobody could reach the admin API).
"""

import asyncio

import structlog
import typer
from db import dispose_engine
from env.custom_rbac import env as access_env
from mistralai_capabilities.custom_rbac.bootstrap import ensure_bootstrap
from mistralai_capabilities.custom_rbac.store import RbacStore

logger = structlog.get_logger("init.custom_rbac")
app = typer.Typer()
INIT_STEP = True  # wired into the deployment init chain (compose services + Helm Jobs)


async def _bootstrap() -> None:
    admins = access_env.bootstrap_admins
    try:
        await ensure_bootstrap(RbacStore(), admins)
    finally:
        await dispose_engine()
    logger.info("access admins bootstrapped", count=len(admins))


@app.command(name="custom-rbac", help=__doc__)
def main() -> None:
    asyncio.run(_bootstrap())
