# Install — `@mistralai-capabilities/feature-custom-rbac`

Adds authorization (RBAC): principals, teams and per-dimension read/write grants, page/tab scoping,
admin act-as, the `/api/v1/custom_rbac` routes, and the admin page (`/custom-rbac`, Admin nav group).
Authentication is not here: the gateway admits the caller and `auth`'s `require_user` identifies them.

## Prerequisites

- Sibling capabilities: `core`, `fastapi`, `auth`, `postgres`, `tanstack-start` and
  `mistral-design-system`.
- Grants key on the gateway-forwarded email (`x-user-email`), so reach the API only through the
  gateway (keep the Helm NetworkPolicy) and use an IdP that asserts verified, non-editable emails.
- `CUSTOM_RBAC_BOOTSTRAP_ADMINS` (Helm: `global.customRbac.bootstrapAdmins`, read by both the init Job
  and the API). Empty means no admin exists and the admin API is unreachable.

## Install

```bash
mistral apps capability add custom-rbac
bun run install-all   # sync the new dependencies
bunx nx run fastapi-tanstack-start:gen-types   # regenerate the web API client; commit the diff
```

The `rbac_*` tables ship in `db/models/custom_rbac.py` with their own migration branch
(`custom_rbac_0001`), so `init-migrations` creates them. An app that already has these tables runs
`alembic stamp custom_rbac_0001` instead (merge case-duplicate emails/team names first).

A pages-only app needs no code: list grantable pages in `CUSTOM_RBAC_PAGES`. An app with data
dimensions calls `install_access(app, policy=PgAccessPolicy(refinements=..., mandatory=...),
catalog=<CatalogProvider>)` once in `create_app`.

Verify with `bun run check`, then run the stack (`bunx nx run compose:dev`), sign in as a bootstrap
admin, and grant a page on `/custom-rbac`.

## Behaviour to know

- No admin can demote or delete themselves, the last admin cannot be removed (409), and bootstrap
  admins are protected (403).
- Every admin mutation logs one `rbac_audit` record on the `access.audit` logger (real caller,
  target, before/after); ship these logs somewhere durable.
- Grants are unioned per dimension across a caller's teams and direct grants, so a refinement one
  team grants also narrows values another team granted without it.

## Environment reference

| Variable                       | Generated default |
| ------------------------------ | ----------------- |
| `CUSTOM_RBAC_POLICY`           | `pg`              |
| `CUSTOM_RBAC_BOOTSTRAP_ADMINS` | (empty)           |
| `CUSTOM_RBAC_PAGES`            | (empty)           |

`CUSTOM_RBAC_POLICY=allow_all` makes every caller an admin (dev only); the Helm chart refuses to
render an API on it.
