"""Discovery and activity-registration tests for the workflows application."""

import mistralai.workflows as workflows


def _workflow_names() -> set[str]:
    discovered = workflows.discover_all_workflows_in_package("worker.workflows")
    return {workflows.get_workflow_definition(workflow_class).name for workflow_class in discovered}


def test_discover_names_are_unique() -> None:
    discovered = workflows.discover_all_workflows_in_package("worker.workflows")
    names = _workflow_names()
    assert len(names) == len(discovered)
