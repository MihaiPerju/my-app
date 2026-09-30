"""Version 1 of the authenticated API. Declares its own ``/v1``; the host adds the API prefix.

Every router beneath this package requires a caller, because the package declares it below. The
rule belongs to the group. No module here asks for authentication, and none can opt out.

Anonymous routes go in ``routers.internal``, which declares an empty rule.
"""

from fastapi import Depends, params
from mistralai_capabilities.fastapi_auth.identity import require_user

# ``/v1`` belongs to this package, not the host: the version is what the package is, so a ``v2`` is
# a new folder. Where the API hangs off (``/api``) stays the host's call. The segment defaults to
# the package name, so there is nothing to declare.

# The access rule, cascading to every module below — including nested packages like `workflows/`
# and `workflows/speech/`, which declare nothing and inherit this.
dependencies: tuple[params.Depends, ...] = (Depends(require_user),)
