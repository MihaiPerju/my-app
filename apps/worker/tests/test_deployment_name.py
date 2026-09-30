"""Deployment identity is one name, shared by every app runtime."""

from env.workflows import Env


def test_runtime_reads_deployment_name_without_local_or_deploy_overrides(monkeypatch) -> None:
    monkeypatch.setenv("DEPLOYMENT_NAME", "deployment-my-app-alice")
    monkeypatch.setenv("DEPLOYMENT_NAME_LOCAL", "legacy-local-name")
    monkeypatch.setenv("DEPLOYMENT_NAME_DEPLOY", "legacy-deploy-name")

    settings = Env(_env_file=None)

    assert settings.deployment_name == "deployment-my-app-alice"
