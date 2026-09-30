"""Discover every workflow class in the `worker.workflows` package and serve them.

Registers no schedules: those are declared in the ``schedules`` command and applied by that
deployment init step, so a cadence change needs no worker restart and replicas cannot register
conflicting copies.
"""

import asyncio
import signal

import mistralai.workflows as workflows
import structlog
from env.logging import env
from mistralai_capabilities.workflows import client as workflows_client
from utils.logging import configure_logging

logger = structlog.get_logger("workflows")


async def main() -> None:
    configure_logging(log_level=env.log_level, log_format=env.log_format)
    workflow_classes = workflows.discover_all_workflows_in_package("worker.workflows")
    names = [workflows.get_workflow_definition(c).name for c in workflow_classes]
    logger.info("workflow discovery complete", total=len(names), workflows=names)

    # Docker, Kubernetes and Koyeb stop a container with SIGTERM, which Python does not handle, so
    # the process would die mid-activity. The SDK tears the worker down (drain, health server,
    # telemetry flush) only when its task is cancelled, which is what SIGTERM is turned into here.
    served = asyncio.current_task()
    stopping = False

    def _stop() -> None:
        nonlocal stopping
        stopping = True
        if served is not None:
            served.cancel()

    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, _stop)
    try:
        await workflows_client.run_worker(workflow_classes)
    except asyncio.CancelledError:
        if not stopping:
            raise
        logger.info("worker stopped on SIGTERM")


if __name__ == "__main__":
    asyncio.run(main())
