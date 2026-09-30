"""Command-line entry points for the workflows capability — the caller side.

`workflow-start` (trigger one execution against a running worker) ships here, in the capability
toolkit installed into the app, not in the app's `worker.workflows` package the worker discovers.
Keeping it out of that package leaves the worker's import graph runtime-only: discovery scans and
imports every module in the `worker.workflows` package, and this command is not part of it.
"""
