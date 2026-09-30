"""The audit trail for the admin matrix: one structured event per privilege change.

Every mutation of who may do what (users, admin flags, grants, teams, memberships) emits an
``rbac_audit`` record on the ``access.audit`` logger, naming the REAL caller (never an act-as
target), the action, its target, and the before/after state where one exists. The fields ride on
``extra`` so a JSON log pipeline indexes them; the message repeats them for plain-text logs.
"""

from __future__ import annotations

import logging

log = logging.getLogger("access.audit")


def audit(actor: str, action: str, **fields: object) -> None:
    detail = " ".join(f"{key}={value!r}" for key, value in fields.items())
    log.info(
        "rbac_audit action=%s actor=%s %s",
        action,
        actor,
        detail,
        extra={"rbac_audit": {"action": action, "actor": actor, **fields}},
    )
