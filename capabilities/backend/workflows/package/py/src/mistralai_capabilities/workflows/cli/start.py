"""Trigger one workflow execution against an already-running worker.

    uv run workflow-start --workflow <name> --input '{}'

Ships in the workflows capability toolkit (`mistralai_capabilities.workflows.cli`), installed
into the app as the `workflow-start` entry point. Dispatching a workflow is a caller-side
operation, kept out of the worker host (`apps/worker` is bootstrap, discovery, and serving only)
and out of the app's discovered `worker.workflows` package. Needs `MISTRAL_API_KEY` and a worker polling
the configured deployment name (`DEPLOYMENT_NAME`). Input is validated against the entrypoint's own
model before dispatch, so a bad payload fails here rather than as a failed execution in the
platform.
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

import mistralai.workflows as workflows_sdk
import structlog
from utils.logging import configure_logging
from env.logging import env as logging_env
from pydantic import ValidationError

from mistralai_capabilities.workflows.client import infer_workflow_models, start_workflow

logger = structlog.get_logger("workflows.execute")


def _resolve_workflow(name: str) -> type:
    """The workflow class registered under ``name``, discovered from the app's ``workflows`` package.

    Caller-side discovery: the worker owns runtime discovery, and this command re-runs the same SDK
    scan only to validate ``--workflow`` before dispatch. It lives in the toolkit, not the worker's
    ``workflows`` package, so the command surface stays out of the worker's import graph. Raises
    ``SystemExit`` with the available names when no such workflow exists — a CLI error, not a
    reusable domain exception.
    """
    by_name = {
        workflows_sdk.get_workflow_definition(cls).name: cls
        for cls in workflows_sdk.discover_all_workflows_in_package("worker.workflows")
    }
    workflow_class = by_name.get(name)
    if workflow_class is None:
        available = ", ".join(sorted(by_name)) or "(none discovered)"
        raise SystemExit(f"Error: no workflow named {name!r}. Available: {available}")
    return workflow_class


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Trigger a workflow execution against a running worker.",
    )
    parser.add_argument("--workflow", required=True, help="Registered workflow name.")
    parser.add_argument(
        "--input",
        default="{}",
        dest="input_json",
        help='Input as a JSON object, e.g. \'{"name": "World"}\'.',
    )
    parser.add_argument(
        "--input-file",
        help="Read the input JSON from a file (`-` for stdin). Takes precedence over --input.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=None,
        help="Seconds to wait for the result. Omitted, the platform decides.",
    )
    parser.add_argument(
        "--no-wait",
        action="store_true",
        help="Return as soon as the execution is accepted, without waiting for a result.",
    )
    return parser.parse_args()


def _read_input(args: argparse.Namespace) -> dict[str, Any]:
    """The input payload, from --input-file if given, else --input."""
    if args.input_file:
        label = f"--input-file {args.input_file}"
        try:
            raw = sys.stdin.read() if args.input_file == "-" else Path(args.input_file).read_text()
        except OSError as exc:
            raise SystemExit(f"Error: reading {label}: {exc}") from exc
    else:
        label, raw = "--input", args.input_json

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Error: invalid JSON in {label}: {exc}") from exc

    if not isinstance(payload, dict):
        raise SystemExit(f"Error: {label} must be a JSON object, got {type(payload).__name__}.")
    return payload


async def _run(args: argparse.Namespace) -> None:
    workflow_class = _resolve_workflow(args.workflow)
    payload = _read_input(args)

    input_model, _ = infer_workflow_models(workflow_class)
    try:
        workflow_input = input_model.model_validate(payload)
    except ValidationError as exc:
        raise SystemExit(f"Error: input does not match {input_model.__name__}:\n{exc}") from exc

    run = await start_workflow(
        workflow_class,
        workflow_input,
        wait_for_result=not args.no_wait,
        timeout_seconds=args.timeout,
    )
    logger.info(
        "workflow dispatched",
        workflow=args.workflow,
        execution_id=run.execution_id,
        result=run.result,
    )


def main() -> None:
    configure_logging(log_level=logging_env.log_level, log_format=logging_env.log_format)
    asyncio.run(_run(_parse_args()))


if __name__ == "__main__":
    main()
