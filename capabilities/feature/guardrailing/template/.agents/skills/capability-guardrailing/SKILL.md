---
name: capability-guardrailing
description: The app's fail-closed guardrail gate — the `guardrails.scan` activity, its four-value classification policy and refusals, and the labelled seed corpus behind a pgvector similarity scanner. Use when a prompt or answer is wrongly blocked or let through, when tuning the threshold or scanner set, when seeding or re-seeding the corpus, or when the gate errors on a missing table or a down database.
---

# Guardrailing

Fail-closed safety gate the agent runs each turn: the `guardrails.scan` activity, its `mistralai-guardrails` config (three scanners — similarity/LLM/moderation — under a max-severity policy over a four-value classification enum), and a labelled pgvector corpus. Owns the gate + its root hook; defers Postgres and the `vector` extension to `capability-postgres`, and the hook-discovery slot to `capability-agents`. Internal gate — no workflow, route, or page.

## Where things live

Vendored (app paths, the surface you edit):
- `packages/py/env/src/env/guardrail.py` — the one file to tune the gate: all `env.guardrail.env` knobs, the `*_effective` edge props, the `llm_classifiers` per-edge seam.
- `apps/worker/src/worker/agents/hooks/guardrail.py` — `GuardrailHook`, a **stateless** `agents.Hook` gating both edges, exported as module-level `hook` and merged into the single orchestrator `Harness` by agents' `assemble_harness` (the per-kind contribution seam; the old `02_` hook-ordering slot is gone). `pre_agent_turn` scans `user_content` and, when it blocks, continues the turn with the content replaced by `refusal_turn_content(refusal)`, so the model never sees the prompt. It records the blocked turn in the module-level `_BLOCKED_TURNS` (one slot per session holding the blocked turn id; never evicted by other sessions, dropped when the answer is accepted, by the session's next turn, or after `BLOCKED_TURN_TTL_SECONDS`; the hook instance stays stateless). Each hook call runs in its own SDK activity, so the slot is per worker process: the override holds within one worker replica and can be missed across replicas or after a restart mid-turn (the turn then relies on the refusal instruction), so `pre_tool_call` skips every tool call of that turn and `post_agent_turn` replaces its answer with the refusal whatever the model said. Do NOT return `PreAgentTurnHookSkip`: the pinned SDK (`mistralai-agents==1.1.0rc6`) fails a skipped turn with "Harness turn … cannot make progress" (pinned by `test_guardrail_hook_runtime.py`, which drives the real runtime offline); `post_agent_turn` scans the answer and swaps in the refusal via `PostAgentTurnHookAccept(ReplaceAssistantContent(...))` (a candidate with no text part scans nothing). Invokes `guardrails_scan` with a `GuardrailScanRequest` of `GuardrailMessage(role, content)` items + `edge`, reading `blocked`/`refusal`.
- `packages/py/cli/src/cli/commands/guardrail.py` — deploy init (`python -m cli guardrail`); seeds corpus, skips unless both `guardrail_enabled` + `guardrail_similarity_enabled`.
- `packages/py/cli/src/cli/commands/seed_guardrail.py` — operator command (`python -m cli seed-guardrail`, `--dataset/--batch-size/--force`); `tasks/guardrailing/project.json` — NX `seed-guardrail` target.
- Tests: `apps/worker/tests/{test_feature_guardrails.py,test_guardrail_hook.py,test_guardrail_hook_runtime.py}`, `packages/py/cli/tests/test_guardrail_init.py`. Change what the hook returns only with the runtime test green: it runs whole turns through `agents.Agent.run` with a scripted in-process model.

Installed toolkit `mistralai_capabilities.guardrails.*` (published `mistralai-capabilities-feature-guardrailing`, CLI-wired into root deps + uv sources — read/import, don't edit):
- `activities.py` — the `guardrails.scan` activity: caches one `Guardrail` per edge, runs the scan, records the verdict.
- `guardrail.py` — `build_guardrail(client, edge)`, `GuardrailPolicy` (max-severity `MALICIOUS→UNSAFE→OUT_OF_SCOPE`), the three scanner assemblers, refusals, `sync_pg_url`.
- `spec.py` — dep-free types: `GuardrailClassification`, `GuardrailEdge`, `ClassifierSpec`/`PromptSpec`, the moderation category names (`MODERATION_CATEGORIES`, `HARM_…`, `TOPIC_…`) and `validate_moderation_categories`.
- `schemas.py` — wire contract `GuardrailScanRequest`/`GuardrailScanResult`/`GuardrailMessage`; `seed.py` — `seed_guardrail_corpus`; `data/seed.json` — 150 labelled prompts (75 malicious, 75 unsafe).

## Extend

- **Moderation categories** — `GUARDRAIL_MODERATION_CATEGORIES` takes the model's own names, validated at startup against the configured `GUARDRAIL_MODERATION_MODEL`'s names in `spec.KNOWN_MODERATION_MODELS` (`mistral-moderation-latest` / `-2603`): harm `sexual`, `hate_and_discrimination`, `violence_and_threats`, `dangerous`, `criminal`, `selfharm`, `jailbreaking` (→ malicious), `pii` (→ unsafe); subject `health`, `financial`, `law` (→ out_of_scope). Empty (the default) = the harm categories only. Add a subject category only to refuse that subject: the model flags ordinary questions about it (a GDPR breach-notification question is `law`). `dangerous_and_criminal_content` does not exist; use `dangerous` and `criminal`. Any other moderation model: list its categories explicitly (`[]` is refused at startup); they are passed through unchecked and the scanner checks them per scan (a name the model does not return fails every scan closed).
- **Tune** — edit `env.guardrail`: model names, moderation categories/thresholds, allowed/forbidden topics, similarity `threshold` (0.90)/`top_k` (2), `guardrail_timeout_seconds` (15s). Never edit the toolkit.
- **Per-edge LLM classifiers** — set `llm_classifiers = {edge: [ClassifierSpec, ...]}` in `env.guardrail.py`; `build_guardrail(edge)` builds that edge's list (moderation + similarity still run every edge). `None` = one joint classifier; an absent edge = no LLM classifier there. Each `ClassifierSpec.allowed_classifications` must include `SAFE` (off-list fails closed); `PromptSpec` takes exactly one of `prompt_template` (+`cache_identity`) / `template_path` (absolute) / `system_prompt_content`.
- **Re-seed** — `bunx nx run guardrailing:seed-guardrail` or the CLI; idempotent unless `--force` (clears + rebuilds); needs `MISTRAL_API_KEY` + `DATABASE_URL`.

## Gotchas

- Fail-closed: any scanner error/timeout → `MALICIOUS`; the only off switch is `GUARDRAIL_ENABLED=false`. Run with `guardrail_similarity_enabled=false` before the corpus is seeded or where there's no DB — an empty/unreachable pgvector table pushes failures into `MALICIOUS`.
- `guardrail_embeddings` (dim 1024) is created by `PgVectorBackend.setup`, not a migration, and that setup also runs `CREATE EXTENSION IF NOT EXISTS vector` (so its role needs that privilege unless the extension already exists). `db:revision` never proposes dropping it: the `db` package's `include_object` filter skips tables no model declares.
- The verdict is published from the activity body (`record_evaluation_result`, once per attempt, replay-safe), not the hook.
