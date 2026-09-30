"""Which credential a call made on someone's behalf spends.

A call made for a caller must spend that caller's credential, whatever supplies it. Where nothing
supplies one the call falls back to the app's own key, and a call with nothing to authenticate it
is refused rather than sent unauthenticated.
"""

from collections.abc import Iterator

import pytest
from utils import mistral as mistral_clients
from utils.mistral import (
    CallerCredentials,
    MistralNotConfiguredError,
    caller_credentials,
    caller_credentials_installed,
    caller_mistral_client,
    install_caller_credentials,
)

PROXY_URL = "https://gateway.test/v1/proxy"
APP_KEY = "app-key"


@pytest.fixture(autouse=True)
def clean_module_state(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(mistral_clients.env, "mistral_api_key", APP_KEY)
    monkeypatch.setattr(mistral_clients.env, "mistral_base_url", None)
    install_caller_credentials(None)
    mistral_clients._caller_client.cache_clear()
    yield
    install_caller_credentials(None)
    mistral_clients._caller_client.cache_clear()


def install_token(token: str | None) -> None:
    """Stand in for a deployment that can act as its callers, holding one token at a time."""

    def provider() -> CallerCredentials:
        if token is None:
            raise MistralNotConfiguredError("this call carries no caller credential")
        return CallerCredentials(server_url=PROXY_URL, token=token)

    install_caller_credentials(provider)


def test_nothing_is_installed_until_a_deployment_installs_it() -> None:
    assert caller_credentials_installed() is False
    assert caller_credentials() is None


def test_an_installed_provider_is_the_source_of_the_caller_credential() -> None:
    install_token("tok-caller")
    assert caller_credentials_installed() is True
    assert caller_credentials() == CallerCredentials(server_url=PROXY_URL, token="tok-caller")


def test_with_nothing_installed_a_caller_call_spends_the_apps_own_key() -> None:
    client = caller_mistral_client()
    assert client.sdk_configuration.server_url is None
    assert client.sdk_configuration.security.api_key == APP_KEY


def test_a_caller_call_spends_the_installed_credential() -> None:
    install_token("tok-caller")
    client = caller_mistral_client()
    assert client.sdk_configuration.server_url == PROXY_URL
    assert client.sdk_configuration.security().api_key == "tok-caller"


def test_one_pooled_client_authenticates_each_call_as_its_own_caller() -> None:
    # The SDK resolves a callable api_key per request, so callers share a client without
    # ever sharing a credential.
    install_token("tok-first")
    first = caller_mistral_client()
    install_token("tok-second")
    second = caller_mistral_client()
    assert first is second
    assert second.sdk_configuration.security().api_key == "tok-second"


def test_removing_the_provider_puts_the_app_back_on_its_own_key() -> None:
    install_token("tok-caller")
    install_caller_credentials(None)
    assert caller_mistral_client().sdk_configuration.security.api_key == APP_KEY


def test_a_dedicated_deployment_keeps_its_own_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mistral_clients.env, "mistral_base_url", "https://dedicated.test")
    assert caller_mistral_client().sdk_configuration.server_url == "https://dedicated.test"


@pytest.mark.parametrize(
    ("api_key", "installed"),
    [
        pytest.param(APP_KEY, True, id="installed_but_no_credential_for_this_call"),
        pytest.param(None, True, id="installed_but_no_credential_and_no_key"),
        pytest.param(None, False, id="nothing_installed_and_no_key"),
    ],
)
def test_a_call_with_nothing_to_authenticate_it_is_refused(
    monkeypatch: pytest.MonkeyPatch,
    api_key: str | None,
    installed: bool,
) -> None:
    monkeypatch.setattr(mistral_clients.env, "mistral_api_key", api_key)
    if installed:
        install_token(None)
    with pytest.raises(MistralNotConfiguredError):
        caller_mistral_client()
