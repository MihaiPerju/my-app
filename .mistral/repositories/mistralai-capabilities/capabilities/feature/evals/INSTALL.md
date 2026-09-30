# Install — `@mistralai-capabilities/feature-evals`

Adds the `packages/py/evals` harness (agent and search tracks: scorers, datasets, LLM judges) and
the scheduled feedback-harvest and prompt-optimization loop the worker runs.

## Prerequisites

- Sibling capabilities: `core`, `search`, `agents`, `workflows` and `observability` (resolved
  automatically).
- A running worker (and its Workflows backend) to dispatch the eval and scheduled workflows.
- `MISTRAL_API_KEY`: the LLM judges and the optimization loop call the Mistral API.
- The scheduled work is off by default. `EVAL_SCHEDULE_ENABLED` arms the nightly agent eval,
  `FEEDBACK_OPTIMIZE_ENABLED` the weekly optimizer, and `FEEDBACK_HARVEST_ENABLED` the nightly
  harvest, which also needs `OBSERVABILITY_READ_ENABLED=true` (from `observability`) and a
  workspace with access to the Studio observability read API.
- After changing a schedule flag, re-run `bunx nx run worker:register-schedules` or redeploy.

## Install

```bash
mistral apps capability add evals
bun run install-all   # sync the new dependencies
bunx nx run worker:register-schedules   # or `bunx nx run compose:init` to run every init step
```

Verify by running a track against the running worker:

```bash
bunx nx run evals:eval-agents
bunx nx run evals:eval-search
```

## Environment reference

| Variable                             | Generated default                  |
| ------------------------------------ | ---------------------------------- |
| `MISTRAL_API_KEY`                    | (empty)                            |
| `EVAL_SCHEDULE_ENABLED`              | `false`                            |
| `EVAL_SCHEDULE_ID`                   | `{{app_name}}-agent-eval`          |
| `EVAL_CRON`                          | `0 3 * * *`                        |
| `EVAL_LOCAL`                         | `false`                            |
| `EVAL_SYSTEM_NAME`                   | `scheduled`                        |
| `FEEDBACK_HARVEST_ENABLED`           | `false`                            |
| `FEEDBACK_HARVEST_SCHEDULE_ID`       | `{{app_name}}-feedback-harvest`    |
| `FEEDBACK_HARVEST_CRON`              | `0 4 * * *`                        |
| `FEEDBACK_HARVEST_WINDOW_HOURS`      | `24`                               |
| `FEEDBACK_EVALUATION_NAME`           | `user_feedback`                    |
| `FEEDBACK_JUDGE_MODEL`               | `mistral-small-latest`             |
| `FEEDBACK_RELEVANCE_THRESHOLD`       | `0.5`                              |
| `FEEDBACK_MIN_RECORDS_TO_EVALUATE`   | `10`                               |
| `FEEDBACK_DATASET_NAME_PREFIX`       | `chat-feedback`                    |
| `FEEDBACK_PROJECT_NAME`              | `Chat feedback`                    |
| `FEEDBACK_OPTIMIZE_ENABLED`          | `false`                            |
| `FEEDBACK_OPTIMIZE_SCHEDULE_ID`      | `{{app_name}}-prompt-optimization` |
| `FEEDBACK_OPTIMIZE_CRON`             | `0 5 * * 0`                        |
| `FEEDBACK_OPTIMIZE_ITERATIONS`       | `8`                                |
| `FEEDBACK_OPTIMIZE_PARETO_SIZE`      | `3`                                |
| `FEEDBACK_OPTIMIZE_MINIBATCH_SIZE`   | `5`                                |
| `FEEDBACK_OPTIMIZE_HOLDOUT`          | `0.2`                              |
| `FEEDBACK_OPTIMIZE_PATIENCE`         | `3`                                |
| `FEEDBACK_OPTIMIZE_RANDOM_SEED`      | `42`                               |
| `FEEDBACK_OPTIMIZE_REFLECTION_MODEL` | `mistral-small-latest`             |
| `FEEDBACK_OPTIMIZE_MUTATION_MODEL`   | `mistral-large-latest`             |
