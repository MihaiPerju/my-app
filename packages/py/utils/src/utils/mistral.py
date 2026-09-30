"""A Mistral SDK client that acts for the caller being served rather than for the app.

Background work can construct a client from ``MISTRAL_API_KEY``. Request-scoped work may instead use
a credential installed by its host and falls back to the application's key when no provider is
installed. The provider slot keeps this shared module independent of any host implementation.
"""

from collections.abc import Callable
from functools import lru_cache
from typing import NamedTuple

from env.mistral import env
from mistralai.client import Mistral


class MistralNotConfiguredError(RuntimeError):
    """Raised when a Mistral client is requested but nothing can authenticate its calls."""


class CallerCredentials(NamedTuple):
    """Where to reach the Mistral API as the caller being served, and the token to do it with."""

    server_url: str
    token: str


CallerCredentialProvider = Callable[[], CallerCredentials]

_provider: CallerCredentialProvider | None = None


def install_caller_credentials(provider: CallerCredentialProvider | None) -> None:
    """Make ``provider`` the source of the credential that work on a caller's behalf spends.

    A host able to act for callers installs one during application setup. ``None`` removes it.
    """
    global _provider
    _provider = provider


def caller_credentials_installed() -> bool:
    """Whether anything can supply a caller credential, without asking it for one."""
    return _provider is not None


def caller_credentials() -> CallerCredentials | None:
    """The credential for the caller being served, or None when the app can act only as itself.

    A provider raises rather than returning None when it is installed but cannot act for this
    particular call, such as a request that arrived without the credential it needs.
    """
    return None if _provider is None else _provider()


def _caller_token() -> str:
    credentials = caller_credentials()
    if credentials is None:
        raise MistralNotConfiguredError("Nothing supplies a caller credential, so there is no caller to act for")
    return credentials.token


@lru_cache(maxsize=1)
def _caller_client(server_url: str) -> Mistral:
    # One client serves every caller: the api_key callable runs per request, so each call
    # authenticates with the credential belonging to the request in flight.
    return Mistral(api_key=_caller_token, server_url=server_url)


def caller_mistral_client() -> Mistral:
    """A client that acts for whoever made the request being served.

    Use while handling caller-scoped work. Where no caller credential is installed, this returns a
    client authenticated with the application's own ``MISTRAL_API_KEY``.
    """
    credentials = caller_credentials()
    if credentials is None:
        if not env.mistral_api_key:
            raise MistralNotConfiguredError("MISTRAL_API_KEY is not configured")
        return Mistral(api_key=env.mistral_api_key, server_url=env.mistral_base_url)
    return _caller_client(credentials.server_url)
