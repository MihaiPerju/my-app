"""Idempotent bootstrap of the RBAC store (sync): keep the configured admins admin.

Meant to run at startup (a sync app's init step), so a fresh deployment has its admins without a
manual step, and a bootstrap admin who was accidentally demoted is restored on the next run
(self-heal). Only the configured emails are touched; every other principal is left exactly as the
admin panel set it. The email match is case-insensitive, so a configured ``Admin@x`` never creates a
duplicate of a stored ``admin@x``.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable

from .store import DuplicatePrincipalError, RbacStore

log = logging.getLogger("custom_rbac.bootstrap")


def ensure_bootstrap(store: RbacStore, admin_emails: Iterable[str]) -> None:
    """Ensure each configured email exists and is an admin (create or re-promote)."""
    emails = list(dict.fromkeys(e.strip() for e in admin_emails if e.strip()))
    existing = {p.email.lower(): p for p in store.principals_by_emails(emails)}
    for email in emails:
        principal = existing.get(email.lower())
        if principal is None:
            try:
                principal = store.create_principal(email=email, name="", is_admin=True)
                log.info("admin_created email=%s", email)
            except DuplicatePrincipalError:
                # A concurrent init run inserted it between the read and this write: adopt that row.
                principal = store.principals_by_emails([email])[0]
            # Record it so a case-insensitive duplicate later in the list ("a@x,A@x") reuses it
            # instead of re-attempting the unique insert.
            existing[email.lower()] = principal
        if not principal.is_admin:
            # A protected admin was demoted; restore it so no one can lock the bootstrap admins out.
            assert principal.id is not None
            store.set_admin(principal.id, True)
            log.info("admin_restored email=%s", email)
    if not emails and not store.admin_emails():
        log.warning(
            "no_admin: CUSTOM_RBAC_BOOTSTRAP_ADMINS is empty and no principal is an admin, "
            "so nobody can reach the admin API"
        )
    duplicates = store.case_duplicate_emails()
    if duplicates:
        # The adopted schema's case-sensitive unique(email) let these in; each resolves to its oldest
        # row, so grants held by the others are ignored until the rows are merged.
        log.error("case_duplicate_principals emails=%s", ",".join(duplicates))
