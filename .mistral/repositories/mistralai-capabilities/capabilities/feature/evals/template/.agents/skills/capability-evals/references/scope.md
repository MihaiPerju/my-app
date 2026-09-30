# scope — define what "good" means

The phase everyone skips, and the reason most evals are useless. Produce a short
spec _before_ any code. No SDK here — just the right questions.

## Do this

0. **Locate what to evaluate — scope to an app, find the candidates.** An eval
   lives _next to_ the thing it tests. First:
   - Ask **"which app/service are we evaluating?"** if the repo has several.
     Default to the obvious one.
   - **Grep for evaluable candidates** — the concrete units an eval can drive:
     ```bash
     # a shared prompt (the ideal "system under test"):
     grep -rlE "SYSTEM_PROMPT|_PROMPT\b" . --include=*.py
     # importable handlers a task can call:
     grep -rnE "async def (complete|run|handle|answer)\b" . --include=*.py
     ```
     Prefer a **shared prompt file** + an **importable handler**: the eval will
     import those so it tests the app's REAL code path, not a copy.
   - Don't name or create the directory yet — the name is _derived_ from the
     conversation once the purpose is clear (step 5).
   - If you find no evaluable unit, say so and offer to help extract one (factor
     the prompt/handler out) before proceeding.

1. **Interview the user.** Ask, in plain language, one question at a time:
   - What does this app do, in one sentence? What's the _system under test_
     (a prompt? an agent? a retrieval step)? Does it get any fixed **ground
     truth / context** (rules, policies, retrieved docs), or must it answer from
     the prompt alone? (This decides what "correct" even means.)
   - Give me 3 example answers: one excellent, one okay, one bad.
   - When you say "bad", _how_ is it bad — wrong facts? wrong format? wrong tone?
     evasive? unsafe? Push until each failure mode is concrete.
   - What would make you ship it? (a rough target per dimension).

2. **Extract quality dimensions.** Turn the answers into 2-4 named dimensions,
   each with a direction. Prefer specific over vague: not "quality" but
   "rule_faithfulness", "no_invented_policy", "actionability". Expect the user to
   surface a dimension you missed while reacting to your examples — that's the
   point of showing examples.

3. **Name the failure modes** that actually hurt. These become the strictest
   evaluators later (e.g. a hard-bar "no_invented_policy").

4. **If there's ground truth, pin it down now.** If the system is judged against
   fixed rules/policies, write those rules explicitly into the spec — the dataset,
   the task, AND the judges will all need them. An answer can only be scored for
   faithfulness against a known truth.

5. **Derive the evaluation name, then write the spec.** From everything above,
   _generate_ a short slug that captures what this eval is about — don't ask the
   user for it (e.g. a support-assistant quality eval → `support-quality`; a
   skill-builder → `skill-builder`). State the name you picked (the user can
   override). Then create **`evaluations/<name>/`** (container `evaluations`,
   never `evals`; no `__init__.py`) and write
   **`evaluations/<name>/eval_spec.md`** — the plan every later phase reads:

   ```markdown
   # Eval spec — <app>

   ## System under test

   <the prompt / agent / step> — ground truth it sees: <rules/context, or "none">

   ## Ground truth (if any)

   <the fixed rules/policies, verbatim>

   ## Quality dimensions

   - <dimension> — <what good looks like> — <higher/lower is better> — <target>

   ## Failure modes (must-not-happen)

   - <failure> — why it hurts
   ```

## Checkpoint

Show `evaluations/<name>/eval_spec.md` and confirm the target (app + evaluable unit),
the dimensions, ground truth, and failure modes before moving on. Then route to
`bootstrap.md`.

## Good vs bad

- ✅ "never cites a delivery time not present in the rules" (testable, specific)
- ✅ "for a _how-to_ question, gives the steps — not just eligibility" (actionability)
- ❌ "be helpful" (untestable — you can't write a scorer or a goal for it)
