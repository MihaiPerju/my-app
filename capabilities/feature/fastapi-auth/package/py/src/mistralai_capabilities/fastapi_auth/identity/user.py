"""The authenticated caller as a structural type, so the gate needn't import a persistence model.

The identity layer declares the shape it needs from the caller row: a stable id and an active flag.
Any object with those attributes satisfies it. Production hands over the SQLModel ``users`` row; a
test hands over a fake. This Protocol keeps ``mistralai_capabilities.fastapi_auth.identity`` free of
``db``.
"""

from typing import Protocol


class User(Protocol):
    user_id: str
    is_active: bool
