from env.workflows import env as workflows_env


def metadata() -> str | None:
    return workflows_env.deployment_name
