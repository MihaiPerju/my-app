"""Root guardrail gate for the orchestrator, contributed as a Unified Harness hook.

One :class:`agents.Hook` gates both edges of every turn. Each edge is gated by its own flag AND
``GUARDRAIL_ENABLED`` (D7). The scan runs in the ``guardrails.scan`` activity. While the output edge
is on the chat stream buffers (a live token is not scanned yet), so deploy the API and worker flags
together.

A blocked prompt is answered with the refusal, deterministically:

- ``pre_agent_turn`` records the turn as blocked and continues it with the user content REPLACED by
  :func:`refusal_turn_content`, so the blocked prompt (every block of it) never reaches the model
  and is not stored in the session history the next turn replays.
- ``pre_tool_call`` skips every tool call of a blocked turn, so no tool runs whatever the model asks.
- ``post_agent_turn`` replaces the answer of a blocked turn with the refusal, whatever the model
  said. The model's compliance is not relied on for the answer or the history.

``post_agent_turn`` also scans the answer of an allowed turn and, on a blocked verdict, swaps it
for the refusal through the same ``ReplaceAssistantContent`` acceptance.

Why not ``PreAgentTurnHookSkip``: in the pinned Agents SDK (``mistralai-agents==1.1.0rc6``) the
Harness core drops a skipped turn without recording a terminal outcome, so the session runtime
raises ``RuntimeError("Harness turn … cannot make progress")``, the turn fails, and the chat shows
that error instead of the refusal. The authoring ``Hook`` has no hook that can end a turn with an
answer (no ``pre_llm_call``; ``post_agent_turn`` may only accept or replace), so the blocked turn
still makes one model call on the refusal instruction. ``tests/test_guardrail_hook_runtime.py``
drives the real runtime and pins both the working path and that SDK behaviour; when the SDK
terminates a skipped turn with its reason, switch back to ``Skip`` (it also saves the model call).

The three hook points of one turn share the blocked verdict through :data:`_BLOCKED_TURNS`: one slot
per session, holding the blocked turn's id and refusal. The hook instance itself holds no state
(``to_workflow`` rejects a stateful hook, and the SDK rebuilds the hook for every invocation), and
the pinned SDK offers no turn-scoped hook state, so the slot lives in this module, once per worker
process. Its lifecycle: ``post_agent_turn`` drops it when the turn's answer is accepted; the
session's next ``pre_agent_turn`` overwrites or drops a slot left by a turn that failed first (a
session runs one turn at a time); and a slot older than :data:`BLOCKED_TURN_TTL_SECONDS` is dropped
when another turn is blocked. Nothing else evicts a slot, so another session cannot push out a live
turn's verdict.

Limit: in the worker's session workflow the SDK runs each hook call in its own
``agents_sdk_harness_capability`` activity. The guarantee holds when a turn's hook activities run in
the worker process that ran its ``pre_agent_turn`` (one worker replica, the default). With several
worker replicas, or a worker restart mid-turn, a later hook call may find no slot. That turn then
falls back to the refusal instruction alone: the model still never sees the blocked prompt, but a
model that ignores the instruction is not overridden. Lifting this needs the SDK to end a skipped
turn with its reason (see above) or to offer turn-scoped hook state.

It reaches the assembled orchestrator ``Harness`` through the module-level ``hook`` that
``assemble_harness`` merges from ``worker/agents/hooks/``; the alpha SDK's folder-scanned,
``NN_``-ordered hook overlay is gone.
"""

from __future__ import annotations

import time
from collections.abc import Sequence
from typing import Any

from env.guardrail import env as guardrail_env
from mistralai.agents import agents
from mistralai.vibe.harness.core import protocol as core_protocol
from mistralai.vibe.harness.runtime.capabilities import (
    PostAgentTurnHookInvocation,
    PreAgentTurnHookInvocation,
    PreToolCallHookContinue,
    PreToolCallHookInvocation,
    PreToolCallHookSkip,
)
from mistralai_capabilities.guardrails import activities as guardrail_activities
from mistralai_capabilities.guardrails.schemas import (
    GuardrailEdge,
    GuardrailMessage,
    GuardrailScanRequest,
)


_BLOCKED_TURNS: dict[str, tuple[str, str, float]] = {}
"""Session id -> ``(turn id, refusal, recorded at)`` of that session's blocked turn. See the module
docstring."""

BLOCKED_TURN_TTL_SECONDS = 3600.0
"""How long a slot outlives its turn at most. A blocked turn is one short model call (a few more if
the model insists on tools, each skipped), so a live turn is far younger than this. A slot this old
belongs to a turn that failed before its answer in a session that never ran another turn, and is
dropped so such sessions cannot grow the worker's memory."""


def _now() -> float:
    return time.monotonic()


def _record_blocked(session_id: str, turn_id: str, refusal: str) -> None:
    # The dict keeps insertion order and a slot is always re-inserted at the tail, so the slots are
    # ordered by age and the expired ones sit at the head: pruning stops at the first live slot.
    now = _now()
    while _BLOCKED_TURNS:
        oldest = next(iter(_BLOCKED_TURNS))
        if now - _BLOCKED_TURNS[oldest][2] <= BLOCKED_TURN_TTL_SECONDS:
            break
        del _BLOCKED_TURNS[oldest]
    _BLOCKED_TURNS.pop(session_id, None)
    _BLOCKED_TURNS[session_id] = (turn_id, refusal, now)


def _blocked_refusal(ctx: agents.Context, turn_id: str) -> str | None:
    """The refusal if ``turn_id`` is its session's blocked turn, else None."""
    slot = _BLOCKED_TURNS.get(ctx.session.id)
    if slot is None or slot[0] != turn_id:
        return None
    return slot[1]


def _text(blocks: Sequence[Any]) -> str:
    """Join the plain-text blocks; non-text parts (images, tool calls, reasoning) carry nothing to scan."""
    return "".join(block.text for block in blocks if isinstance(block, core_protocol.TextContentBlock))


async def _refusal(text: str, *, enabled: bool, edge: GuardrailEdge) -> str | None:
    if not enabled or not text:
        return None
    result = await guardrail_activities.guardrails_scan(
        GuardrailScanRequest(messages=[GuardrailMessage(role="user", content=text)], edge=edge)
    )
    if not result.blocked:
        return None
    return result.refusal or guardrail_env.guardrail_refusal_message


def refusal_turn_content(refusal: str) -> list[core_protocol.ContentBlock]:
    """The user content a blocked turn continues with: the refusal to restate, and nothing else.

    It replaces the whole prompt, images and attachments included, so the blocked content never
    reaches the model and is not stored in the session history the next turn replays.
    """
    return [
        core_protocol.TextContentBlock(
            text=(
                "[The user's message was withheld by the safety policy.] Do not call any tools. "
                "Reply with exactly the following text, and nothing else:\n\n"
                f"{refusal}"
            )
        )
    ]


class GuardrailHook(agents.Hook):
    async def pre_agent_turn(
        self, ctx: agents.Context, request: PreAgentTurnHookInvocation
    ) -> agents.hook.PreAgentTurnHookContinue:
        refusal = await _refusal(
            _text(request.user_content), enabled=guardrail_env.guardrail_input_effective, edge="input"
        )
        if refusal is None:
            # Drops a slot left by an earlier blocked turn of this session that failed before its answer.
            _BLOCKED_TURNS.pop(ctx.session.id, None)
            return agents.hook.PreAgentTurnHookContinue(user_content=request.user_content)
        _record_blocked(ctx.session.id, request.turn_id, refusal)
        return agents.hook.PreAgentTurnHookContinue(user_content=refusal_turn_content(refusal))

    async def pre_tool_call(
        self, ctx: agents.Context, call: PreToolCallHookInvocation
    ) -> PreToolCallHookContinue | PreToolCallHookSkip:
        # A blocked turn runs no tool, even if the model ignores the refusal instruction and asks.
        refusal = _blocked_refusal(ctx, call.turn_id)
        if refusal is not None:
            return PreToolCallHookSkip(reason=[core_protocol.TextContentBlock(text=refusal)])
        return PreToolCallHookContinue(effective_arguments=call.tool_call.call.arguments)

    async def post_agent_turn(
        self, ctx: agents.Context, result: PostAgentTurnHookInvocation
    ) -> agents.hook.PostAgentTurnHookAccept:
        blocked = _blocked_refusal(ctx, result.turn_id)
        if blocked is not None:
            # The answer to a blocked prompt is the refusal, whatever the model said.
            del _BLOCKED_TURNS[ctx.session.id]
            return _replace_with(blocked)
        # A candidate that carries no text part (only tool calls / reasoning) scans nothing, so
        # `_refusal` returns None and the model's answer is accepted unchanged.
        refusal = await _refusal(
            _text(result.candidate.message.content),
            enabled=guardrail_env.guardrail_output_effective,
            edge="output",
        )
        if refusal is None:
            return agents.hook.PostAgentTurnHookAccept()
        return _replace_with(refusal)


def _replace_with(refusal: str) -> agents.hook.PostAgentTurnHookAccept:
    return agents.hook.PostAgentTurnHookAccept(
        acceptance=core_protocol.ReplaceAssistantContent(content=[core_protocol.TextContentBlock(text=refusal)])
    )


hook: agents.Hook = GuardrailHook()
