"""Guard direct, directory-scoped checks against a stray ``AGENT`` variable.

The root target removes ``AGENT`` in ``tools/uv.sh``. Keep this local guard for developers who run
pytest directly against the agent project.
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
