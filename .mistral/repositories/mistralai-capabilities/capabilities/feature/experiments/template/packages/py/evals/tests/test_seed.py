"""Smoke tests for the template coverage floor — exhaustive tests live in the package suite."""

from pathlib import Path

import pytest
import yaml
from evals.seed import (
    _artifact_path,
    _load_yaml_mapping,
    _read_artifact_file,
    _read_experiment_file,
    seed_name_from_path,
)


def test_seed_name_simple() -> None:
    assert seed_name_from_path("prompt/v1.yaml") == "prompt:v1"


def test_seed_name_nested() -> None:
    assert seed_name_from_path("prompt/classification/v1.yaml") == "prompt:classification:v1"


def test_seed_name_strips_prefix_and_category() -> None:
    assert seed_name_from_path("seed/artifact/prompt/v1.yaml", category="artifact") == "prompt:v1"


def test_seed_name_dot_prefix() -> None:
    assert seed_name_from_path("./prompt/v1.yaml") == "prompt:v1"


def test_seed_name_empty_raises() -> None:
    with pytest.raises(ValueError, match="empty seed path"):
        seed_name_from_path("")


def test_seed_name_only_prefix_raises() -> None:
    with pytest.raises(ValueError, match="names no artifact"):
        seed_name_from_path("seed/", category="experiment")


def test_artifact_path_finds_yaml(tmp_path: Path) -> None:
    d = tmp_path / "artifact" / "prompt"
    d.mkdir(parents=True)
    expected = d / "v1.yaml"
    expected.write_text("type: prompt\ncontent: {}")
    assert _artifact_path(tmp_path, "prompt:v1") == expected


def test_artifact_path_missing_raises(tmp_path: Path) -> None:
    (tmp_path / "artifact").mkdir()
    with pytest.raises(FileNotFoundError, match="no seed file"):
        _artifact_path(tmp_path, "nope:v1")


def test_artifact_path_absolute_raises(tmp_path: Path) -> None:
    (tmp_path / "artifact").mkdir()
    with pytest.raises(ValueError, match="must not escape"):
        _artifact_path(tmp_path, "/tmp/private:v1")


def test_artifact_path_traversal_raises(tmp_path: Path) -> None:
    (tmp_path / "artifact").mkdir()
    with pytest.raises(ValueError, match="must not escape"):
        _artifact_path(tmp_path, "..:secret:v1")


def test_artifact_path_empty_part_raises(tmp_path: Path) -> None:
    (tmp_path / "artifact").mkdir()
    with pytest.raises(ValueError, match="invalid artifact name"):
        _artifact_path(tmp_path, "prompt::v1")


def test_artifact_path_dotted_name(tmp_path: Path) -> None:
    """Artifact names containing dots must not lose the dot component via suffix replacement."""
    d = tmp_path / "artifact" / "prompt"
    d.mkdir(parents=True)
    expected = d / "v1.2.yaml"
    expected.write_text("type: prompt\ncontent: {}")
    assert _artifact_path(tmp_path, "prompt:v1.2") == expected


def test_artifact_path_relative_seed_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """_artifact_path must work when seed_root is relative (not pre-resolved)."""
    d = tmp_path / "seed" / "artifact" / "prompt"
    d.mkdir(parents=True)
    expected = d / "v1.yaml"
    expected.write_text("type: prompt\ncontent: {}")
    monkeypatch.chdir(tmp_path)
    result = _artifact_path(Path("seed"), "prompt:v1")
    assert result == Path("seed/artifact/prompt/v1.yaml")


def test_load_yaml_mapping(tmp_path: Path) -> None:
    f = tmp_path / "m.yaml"
    f.write_text(yaml.dump({"k": "v"}))
    assert _load_yaml_mapping(f) == {"k": "v"}


def test_load_yaml_mapping_non_dict_raises(tmp_path: Path) -> None:
    f = tmp_path / "bad.yaml"
    f.write_text(yaml.dump([1, 2]))
    with pytest.raises(ValueError, match="YAML mapping"):
        _load_yaml_mapping(f)


def test_read_experiment_file(tmp_path: Path) -> None:
    p = tmp_path / "experiment" / "b.yaml"
    p.parent.mkdir(parents=True)
    p.write_text("feature: cls\nconfig:\n  model: m\nartifacts:\n  - prompt:v1\n")
    name, feature, config, arts = _read_experiment_file(p, tmp_path)
    assert name == "b"
    assert feature == "cls"
    assert config == {"model": "m"}
    assert arts == ["prompt:v1"]


def test_read_experiment_file_defaults(tmp_path: Path) -> None:
    p = tmp_path / "experiment" / "simple.yaml"
    p.parent.mkdir(parents=True)
    p.write_text("feature: x\n")
    _, _, config, arts = _read_experiment_file(p, tmp_path)
    assert arts == []
    assert config == {}


def test_read_experiment_file_missing_feature_raises(tmp_path: Path) -> None:
    p = tmp_path / "experiment" / "bad.yaml"
    p.parent.mkdir(parents=True)
    p.write_text("config: {}\n")
    with pytest.raises(ValueError, match="non-empty string 'feature'"):
        _read_experiment_file(p, tmp_path)


def test_read_experiment_file_bad_artifacts_raises(tmp_path: Path) -> None:
    p = tmp_path / "experiment" / "bad.yaml"
    p.parent.mkdir(parents=True)
    p.write_text("feature: x\nartifacts: oops\n")
    with pytest.raises(ValueError, match="list of artifact-name strings"):
        _read_experiment_file(p, tmp_path)


def test_read_experiment_file_bad_config_raises(tmp_path: Path) -> None:
    p = tmp_path / "experiment" / "bad.yaml"
    p.parent.mkdir(parents=True)
    p.write_text("feature: x\nconfig: 42\n")
    with pytest.raises(ValueError, match="must be a mapping"):
        _read_experiment_file(p, tmp_path)


def test_read_artifact_file(tmp_path: Path) -> None:
    p = tmp_path / "artifact" / "sys.yaml"
    p.parent.mkdir(parents=True)
    p.write_text("type: prompt\nscope: cls\ncontent:\n  t: hello\n")
    name, art_type, scope, content = _read_artifact_file(p, tmp_path)
    assert name == "sys"
    assert art_type == "prompt"
    assert scope == "cls"
    assert content == {"t": "hello"}


def test_read_artifact_file_defaults(tmp_path: Path) -> None:
    p = tmp_path / "artifact" / "sys.yaml"
    p.parent.mkdir(parents=True)
    p.write_text("type: system_prompt\n")
    _, _, scope, content = _read_artifact_file(p, tmp_path)
    assert scope == ""
    assert content == {}


def test_read_artifact_file_missing_type_raises(tmp_path: Path) -> None:
    p = tmp_path / "artifact" / "bad.yaml"
    p.parent.mkdir(parents=True)
    p.write_text("content: {}\n")
    with pytest.raises(ValueError, match="non-empty string 'type'"):
        _read_artifact_file(p, tmp_path)


def test_read_artifact_file_bad_content_raises(tmp_path: Path) -> None:
    p = tmp_path / "artifact" / "bad.yaml"
    p.parent.mkdir(parents=True)
    p.write_text("type: prompt\ncontent: just a string\n")
    with pytest.raises(ValueError, match="must be a mapping"):
        _read_artifact_file(p, tmp_path)


def test_read_artifact_file_bad_scope_raises(tmp_path: Path) -> None:
    p = tmp_path / "artifact" / "bad.yaml"
    p.parent.mkdir(parents=True)
    p.write_text("type: prompt\nscope: [a, b]\n")
    with pytest.raises(ValueError, match="must be a string"):
        _read_artifact_file(p, tmp_path)
