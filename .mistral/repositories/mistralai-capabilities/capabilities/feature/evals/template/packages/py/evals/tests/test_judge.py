import importlib

from mistralai.client import Mistral
from mistralai.client.utils import retries


def test_judge_module_imports_against_the_installed_sdk() -> None:
    # A real import, not a monkeypatched one: the scorers and the feedback harvest both load
    # `evals.judge`, so an SDK path that moved would fail every judge at worker start.
    judge = importlib.import_module("evals.judge")

    assert judge.RetryConfig is retries.RetryConfig
    assert judge.BackoffStrategy is retries.BackoffStrategy


def test_judge_retry_config_is_accepted_by_the_client() -> None:
    from evals.judge import (
        JUDGE_RETRY_INITIAL_MS,
        JUDGE_RETRY_MAX_ELAPSED_MS,
        JUDGE_RETRY_MAX_INTERVAL_MS,
        JUDGE_SCORER_TIMEOUT,
        judge_retry_config,
    )

    config = judge_retry_config()
    assert isinstance(config, retries.RetryConfig)
    assert config.strategy == "backoff"
    assert config.retry_connection_errors is True
    assert config.backoff.initial_interval == JUDGE_RETRY_INITIAL_MS
    assert config.backoff.max_interval == JUDGE_RETRY_MAX_INTERVAL_MS
    # The whole retry budget fits inside one scorer attempt, so a wait is never cut off mid-way.
    assert config.backoff.max_elapsed_time < JUDGE_SCORER_TIMEOUT.total_seconds() * 1000
    assert JUDGE_RETRY_MAX_ELAPSED_MS == config.backoff.max_elapsed_time

    client = Mistral(api_key="test", retry_config=config)
    assert client.sdk_configuration.retry_config is config
