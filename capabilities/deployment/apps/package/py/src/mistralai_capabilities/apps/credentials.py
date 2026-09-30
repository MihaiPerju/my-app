"""Host wiring: the gateway's caller token as the credential a caller's Mistral API calls spend.

The rest of ``mistralai_capabilities.apps`` names no Mistral client. This module is the one place
that reaches into ``utils.mistral``, binding the gateway onto the provider slot it offers. Import
it from the API host only.
"""

from collections.abc import Callable

from env.gateway import env
from fastapi import FastAPI
from mistralai_capabilities.apps.middleware import GatewayTokenMiddleware
from mistralai_capabilities.apps.tokens import current_token
from utils.mistral import (
    CallerCredentials,
    MistralNotConfiguredError,
    install_caller_credentials,
)

__all__ = ["caller_credentials_via", "install_gateway_credentials"]


def caller_credentials_via(proxy_url: str) -> Callable[[], CallerCredentials]:
    """A provider that reaches the Mistral API at ``proxy_url`` as the caller being served."""

    def credentials() -> CallerCredentials:
        token = current_token()
        if not token:
            raise MistralNotConfiguredError(
                "This request carries no gateway token, so there is no caller to act for. "
                "Work that belongs to no caller should build its own client on MISTRAL_API_KEY."
            )
        return CallerCredentials(server_url=proxy_url, token=token)

    return credentials


def install_gateway_credentials(app: FastAPI) -> None:
    """Let ``app`` act as its callers, when there is a gateway in front of it to act through.

    Returns without touching ``app`` where no proxy URL is set. `mistral apps dev` injects one into
    every module it runs, but a deployment that serves the app directly does not, and a provider
    installed with nothing to provide would refuse every call the app's own key would have served.
    """
    if not env.apps_proxy_url:
        return
    app.add_middleware(GatewayTokenMiddleware)
    install_caller_credentials(caller_credentials_via(env.apps_proxy_url))
