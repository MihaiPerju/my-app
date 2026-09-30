"""The conversational surface, served as sessions on the vibe_agents control plane.

`/chat` names the resource the browser talks to; a single index module mounts the whole session
surface for one agent. It is not under `/workflows`, because a chat session is not an execution this
API starts; the control plane owns its lifecycle. This package declares no access rule: `v1` declares
``(Depends(require_user),)`` and the loader cascades it, so every route below has a resolved caller.
"""
