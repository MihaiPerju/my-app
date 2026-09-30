"""Workspace-wide pytest bootstrap, loaded before any test module is imported.

`mistralai.workflows` builds a `WorkerConfig` at import time, whose `agent` field reads an unprefixed
`AGENT` variable. A machine that exports `AGENT` makes every SDK import fail. `AGENT` means nothing
to this repo, so it is dropped here. Payload encryption is forced off for deterministic tests,
because the generated ``.env`` defaults to partial encryption, which would turn an offline suite
into a live call.
"""

import os
import warnings

_stray_agent = os.environ.pop("AGENT", None)
if _stray_agent is not None:
    warnings.warn(
        f"Dropped a stray AGENT={_stray_agent!r} from the environment: it is read by the Mistral "
        "SDK's WorkerConfig and would abort collection. Unset it in your shell to silence this.",
        RuntimeWarning,
        stacklevel=1,
    )

os.environ["WORKFLOWS_ENCRYPTION_MODE"] = "off"
