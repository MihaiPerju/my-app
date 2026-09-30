"""User directory: a non-admin lookup for share pickers.

Any authenticated caller may read this to pick who to share with (unlike ``/admin/users``,
which is admin-only). It lists the RBAC principals; an app can widen it with more sources later
(e.g. the analytics capability's recent actors). Returns empty when the store holds no
principals, so the UI falls back to free-text emails.
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from .seams import StoreDep

router = APIRouter(prefix="/users", tags=["users"])

#: Cap the directory so a large workspace never returns an unbounded list.
_MAX = 50


class DirectoryUser(BaseModel):
    email: str
    name: str = ""


@router.get("", response_model=list[DirectoryUser])
async def list_directory(store: StoreDep, q: str = "") -> list[DirectoryUser]:
    # The case-insensitive match, ordering and cap all run in SQL, so a common query never scans
    # and transfers the whole workspace to filter it in Python.
    principals = await store.search_principals(q, _MAX)
    return [DirectoryUser(email=p.email, name=p.name or "") for p in principals]
