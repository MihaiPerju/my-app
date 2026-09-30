# Install — `@mistralai-capabilities/feature-experiments`

Feature-agnostic experiment framework layered on the `evals` capability. Provides named experiment
variants keyed by `(feature, name)`, content-addressed artifacts, active-experiment promotion,
seed-based YAML loading, and result tracking.

## Prerequisites

- **`evals`** capability selected — experiments extends the eval infrastructure with experiment
  resolution, seed loading, and DB persistence.

## Depends on

`core`, `evals`.

## What it adds

- **DB models** — `Experiment`, `ExperimentArtifact`, `ExperimentResult`, `ActiveExperiment`,
  `Artifact` (5 SQLModel tables via a standalone Alembic branch).
- **DB accessors** — async CRUD for experiments, artifacts, results, and active-experiment promotion.
- **Experiment runner** — `resolve_experiment()`, request/plan/result Pydantic models.
- **Seed loader** — `load_experiment_from_seed()` reads YAML seed folders into the DB.
- **Env settings** — `EXPERIMENTS_ENABLED` gate (default `false`).
