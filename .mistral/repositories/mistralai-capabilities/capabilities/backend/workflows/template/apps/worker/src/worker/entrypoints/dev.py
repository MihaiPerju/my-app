"""Serve the worker, restarting it when the code it serves changes."""

import os
import shlex
import sys
from pathlib import Path

from watchfiles import run_process

# <app root>/apps/worker/src/worker/entrypoints/dev.py
ROOT = Path(__file__).resolve().parents[5]
# The worker's own code and every shared package it imports (`env`, `utils`, and those capabilities add).
WATCH = (ROOT / "apps/worker/src", ROOT / "packages/py")
# This interpreter is already the workspace venv, so the worker runs directly under it. A `uv run`
# in between would receive watchfiles' SIGINT on reload instead of the worker, and leave it orphaned.
SERVE = shlex.join([sys.executable, "-m", "worker.entrypoints.worker"])


def main() -> None:
    # The worker runs from the app root wherever this is launched (the image starts it from apps/worker).
    os.chdir(ROOT)
    run_process(*WATCH, target=SERVE, target_type="command")


if __name__ == "__main__":
    main()
