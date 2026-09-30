"""Reading a number back out of an LLM judge's reply.

Two judges ask a model for a 0..10 rating: ``evals.scorers.response_quality`` grades an agent
answer, and the feedback harvest relevance pass (``mistralai_capabilities.feedback``) corroborates
a user's thumbs-up/down. Both read the same 0..10 reply, so the shared parser lives here in the
``evals`` harness and the feedback harvest imports it from ``evals.judge`` — the one code edge
between the two packages. Two copies must not diverge: a divergence does not fail anything, it
silently re-weights one signal and shows up as a metric nobody trusts.

The judges' shared retry policy lives here for the same reason.
"""

import re
from datetime import timedelta

from mistralai.client.utils.retries import BackoffStrategy, RetryConfig

_FIRST_NUMBER = re.compile(r"\d+(?:\.\d+)?")

# A run fans every record's judge out at once, so the first thing a judge meets on a real dataset is
# a 429. Without a retry the scorer fails, the plugin records an error score, and the evaluator's
# average is computed over whatever survived -- a run that scored 2 of 15 records still reported a
# clean mean. The SDK retries 429 and 5xx (honouring `Retry-After`) and dropped connections under
# this policy; the budget stays inside `JUDGE_SCORER_TIMEOUT` so an attempt is not cut off mid-wait.
JUDGE_RETRY_INITIAL_MS = 2_000
JUDGE_RETRY_MAX_INTERVAL_MS = 30_000
JUDGE_RETRY_MAX_ELAPSED_MS = 120_000
JUDGE_SCORER_TIMEOUT = timedelta(minutes=3)
# Judges share the plugin's per-record scorer fan-out; fewer in flight keeps a run under the
# account's rate limit instead of retrying its way through it.
JUDGE_SCORER_MAX_CONCURRENCY = 2


def judge_retry_config() -> RetryConfig:
    """The retry policy every LLM-judge client is built with."""
    return RetryConfig(
        "backoff",
        BackoffStrategy(
            initial_interval=JUDGE_RETRY_INITIAL_MS,
            max_interval=JUDGE_RETRY_MAX_INTERVAL_MS,
            exponent=2.0,
            max_elapsed_time=JUDGE_RETRY_MAX_ELAPSED_MS,
        ),
        retry_connection_errors=True,
    )


def parse_rating(text: str) -> float:
    """A 0..10 judge reply, normalized to 0..1 and clamped.

    "8", "8/10" and "I rate this 8 out of 10" all mean 0.8, so the first number wins. No
    number scores zero rather than raising, so one unparseable reply costs one record, not
    the batch.
    """
    match = _FIRST_NUMBER.search(text or "")
    if match is None:
        return 0.0
    return max(0.0, min(1.0, float(match.group()) / 10.0))
