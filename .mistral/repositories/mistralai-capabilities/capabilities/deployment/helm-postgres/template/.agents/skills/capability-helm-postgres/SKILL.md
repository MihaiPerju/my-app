---
name: capability-helm-postgres
description: The in-cluster Postgres Helm subchart — a single StatefulSet + ClusterIP Service under `deploy/helm/app/charts/postgres`, rendered behind `enabled && global.postgres.deploy`. A hidden overlay that ships automatically when both `helm` and `postgres` are selected. Use when the cluster Postgres pod will not start or its manifest will not render, when changing persistence, storage class, or resources, when the password Secret or `PGDATA` volume layout needs wiring, or when switching the app to an external managed Postgres.
---

# Helm — Postgres

Ships the in-cluster `postgres` Helm subchart — a single-replica `StatefulSet` + its `ClusterIP` `Service` under `deploy/helm/app/charts/postgres`, rendered only when `enabled && global.postgres.deploy`. Owns **only** these subchart files: the `global.postgres.*` knobs (image, auth, resources, persistence, service) live in the parent chart values (owned by `helm`); the compose overlay, first-boot extension script, and `DATABASE_URL` default belong to `postgres`; the schema lives in `packages/py/db` migrations.

## Where things live

| Path | What |
| --- | --- |
| `deploy/helm/app/charts/postgres/Chart.yaml` | Subchart metadata (`name: postgres`); depends on the `common` library subchart (`file://../common`) for every name/label/security-context/Secret helper. |
| `deploy/helm/app/charts/postgres/values.yaml` | Subchart-local defaults — only `enabled: true`. Server config lives in the parent's `global.postgres.*`. |
| `deploy/helm/app/charts/postgres/templates/statefulset.yaml` | The `StatefulSet` **and** its `ClusterIP` `Service` (two docs in one file), wrapped in the render gate. |

## Extend

- **Render gate:** whole manifest is `{{- if and .Values.enabled .Values.global.postgres.deploy }}`. Set `global.postgres.deploy: false` for a managed/external Postgres — this subchart then renders nothing.
- **Persistence:** `global.postgres.persistence.enabled` true → `volumeClaimTemplates` PVC (`ReadWriteOnce`, `persistence.size`, optional `persistence.storageClass`, survives reschedule); false → `emptyDir` (wiped when the Pod is deleted/replaced/moved).
- **Image:** container runs `global.postgres.image.{repository,tag}` (`timescale/timescaledb-ha`, carries pgvector). `PGDATA` is `/home/postgres/pgdata/data` and the `data` volume mounts the parent `/home/postgres/pgdata`; `run` + `tmp` are `emptyDir`. Swap the image → re-check this path (stock `postgres` uses `/var/lib/postgresql/data`).
- **Naming/auth:** name, labels, `serviceAccountName`, `imagePullSecrets`, and security contexts all resolve via `common` (`common.postgresName`, …) — can't render without `common`. `POSTGRES_USER`/`POSTGRES_DB` come from `global.postgres.auth.{username,database}`; the password is read from the shared Secret (`common.secretName`, key `global.postgres.auth.passwordSecretKey`) — never in values.

## Gotchas

- Both gate flags must be true or the StatefulSet + Service both vanish — the usual "helm installed but no Postgres pod."
- Both probes are `pg_isready -U <username>`; a wrong username leaves the pod stuck `NotReady`.
