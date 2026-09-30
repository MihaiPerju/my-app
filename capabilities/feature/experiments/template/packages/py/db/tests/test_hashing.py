from db.hashing import artifact_hash, experiment_definition_hash


def test_artifact_hash_deterministic() -> None:
    h1 = artifact_hash("prompt", {"text": "hello"})
    h2 = artifact_hash("prompt", {"text": "hello"})
    assert h1 == h2
    assert len(h1) == 64


def test_artifact_hash_key_order_independent() -> None:
    h1 = artifact_hash("prompt", {"a": 1, "b": 2})
    h2 = artifact_hash("prompt", {"b": 2, "a": 1})
    assert h1 == h2


def test_artifact_hash_type_matters() -> None:
    h1 = artifact_hash("prompt", {"text": "hello"})
    h2 = artifact_hash("dataset", {"text": "hello"})
    assert h1 != h2


def test_experiment_definition_hash_deterministic() -> None:
    h1 = experiment_definition_hash({"lr": 0.01}, ["art_a", "art_b"])
    h2 = experiment_definition_hash({"lr": 0.01}, ["art_a", "art_b"])
    assert h1 == h2
    assert len(h1) == 64


def test_experiment_definition_hash_sorts_artifacts() -> None:
    h1 = experiment_definition_hash({}, ["b", "a"])
    h2 = experiment_definition_hash({}, ["a", "b"])
    assert h1 == h2


def test_experiment_definition_hash_config_matters() -> None:
    h1 = experiment_definition_hash({"lr": 0.01}, ["a"])
    h2 = experiment_definition_hash({"lr": 0.1}, ["a"])
    assert h1 != h2
