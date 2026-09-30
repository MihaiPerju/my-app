"""The caller ``/chat`` acts for, as a dependency.

Two jobs. It refuses early when nothing can authenticate a call to the agents API, so an
unconfigured deployment answers 503 rather than a stack trace on every poll of the sidebar. And it
names the app user, which the mount writes onto each session it opens and filters the listing by.
On a deployment with one API key the agents API sees a single principal for everybody, so that tag
is all that keeps two people apart. A caller credential already separates them upstream.
"""

from typing import Annotated

from fastapi import Depends, HTTPException
from mistralai_capabilities.chat.vibe.client import VibeAgentsNotConfiguredError, ensure_reachable
from mistralai_capabilities.fastapi_auth.identity import CurrentUser


def _caller(user: CurrentUser) -> str:
    try:
        ensure_reachable()
    except VibeAgentsNotConfiguredError as error:
        raise HTTPException(status_code=503, detail="Chat is not configured on this deployment") from error
    return user.user_id


ChatCaller = Annotated[str, Depends(_caller)]
