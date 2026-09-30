# Install — `@mistralai-capabilities/feature-guardrailing`

Adds a fail-closed guardrail the agent runs on every turn: similarity, LLM and moderation scanners
over the prompt (and optionally the answer), with a pgvector corpus for the similarity scanner.

## Prerequisites

- Sibling capabilities: `core`, `postgres`, `agents` and `workflows` (resolved automatically).
- A Postgres with the `vector` extension reachable at `DATABASE_URL` (provided by `postgres`).
- `MISTRAL_API_KEY`: the scanners call the Mistral API, and seeding embeds the corpus.
- The similarity scanner (`GUARDRAIL_SIMILARITY_ENABLED=true` by default) needs the seeded
  `guardrail_embeddings` table. The gate fails closed, so if the table is missing or unreachable
  every prompt is blocked: seed it, or set `GUARDRAIL_SIMILARITY_ENABLED=false`.
- `GUARDRAIL_MODERATION_CATEGORIES`, `GUARDRAIL_MODERATION_THRESHOLDS`, `GUARDRAIL_ALLOWED_TOPICS`
  and `GUARDRAIL_FORBIDDEN_TOPICS` must hold valid JSON (`[]` / `{}`), never a blank value.
- With a `GUARDRAIL_MODERATION_MODEL` other than `mistral-moderation-latest` or
  `mistral-moderation-2603`, list its category names in `GUARDRAIL_MODERATION_CATEGORIES`: the
  worker refuses to start with `[]`, and a name the model does not return blocks every prompt.
- `GUARDRAIL_MODERATION_CATEGORIES=[]` checks harm categories only; adding `health`, `financial` or
  `law` refuses every question on that subject.

## Install

```bash
mistral apps capability add guardrailing
bun run install-all   # sync the new dependencies
bunx nx run guardrailing:seed-guardrail   # idempotent; pass --force to clear and rebuild
```

The `guardrail` init step (run by `bunx nx run compose:init`) also seeds the corpus when
`GUARDRAIL_ENABLED` and `GUARDRAIL_SIMILARITY_ENABLED` are both true. Verify with
`bunx nx run testing:test`.

## Environment reference

| Variable                          | Generated default                       |
| --------------------------------- | --------------------------------------- |
| `GUARDRAIL_ENABLED`               | `true`                                  |
| `MISTRAL_API_KEY`                 | (empty)                                 |
| `GUARDRAIL_INPUT_ENABLED`         | `true`                                  |
| `GUARDRAIL_OUTPUT_ENABLED`        | `false`                                 |
| `GUARDRAIL_REFUSAL_MESSAGE`       | `I'm unable to help with that request.` |
| `GUARDRAIL_SIMILARITY_ENABLED`    | `true`                                  |
| `GUARDRAIL_EMBEDDINGS_TABLE`      | `guardrail_embeddings`                  |
| `GUARDRAIL_SIMILARITY_THRESHOLD`  | `0.90`                                  |
| `GUARDRAIL_SIMILARITY_TOP_K`      | `2`                                     |
| `GUARDRAIL_LLM_MODEL`             | `mistral-small-latest`                  |
| `GUARDRAIL_MODERATION_MODEL`      | `mistral-moderation-latest`             |
| `GUARDRAIL_MODERATION_CATEGORIES` | `[]`                                    |
| `GUARDRAIL_MODERATION_THRESHOLDS` | `{}`                                    |
| `GUARDRAIL_ALLOWED_TOPICS`        | `[]`                                    |
| `GUARDRAIL_FORBIDDEN_TOPICS`      | `[]`                                    |
| `GUARDRAIL_TIMEOUT_SECONDS`       | `15.0`                                  |
