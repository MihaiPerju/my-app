"""Unit tests for the pure helpers in ``evals.seed``.

These functions convert file paths to colon-joined names, locate seed files on disk,
and parse YAML experiment / artifact files. They need no database and no async runtime.
"""

from pathlib import Path

import pytest
import yaml

from evals.seed import (
    _artifact_path,
    _load_yaml_mapping,
    _read_artifact_file,
    _read_experiment_file,
)
from mistralai_capabilities.experiments.seed import seed_name_from_path


# ---------------------------------------------------------------------------
# seed_name_from_path
# ---------------------------------------------------------------------------


class TestSeedNameFromPath:
    def test_simple_file(self) -> None:
        assert seed_name_from_path("prompt/v1.yaml") == "prompt:v1"

    def test_nested_path(self) -> None:
        assert seed_name_from_path("prompt/classification/v1.yaml") == "prompt:classification:v1"

    def test_strips_seed_prefix(self) -> None:
        assert seed_name_from_path("seed/prompt/v1.yaml") == "prompt:v1"

    def test_strips_category(self) -> None:
        assert seed_name_from_path("seed/experiment/baseline.yaml", category="experiment") == "baseline"

    def test_strips_category_and_nested(self) -> None:
        assert (
            seed_name_from_path("seed/artifact/prompt/classification/v1.yaml", category="artifact")
            == "prompt:classification:v1"
        )

    def test_dot_prefix_stripped(self) -> None:
        assert seed_name_from_path("./prompt/v1.yaml") == "prompt:v1"

    def test_yml_extension(self) -> None:
        assert seed_name_from_path("prompt/v1.yml") == "prompt:v1"

    def test_json_extension(self) -> None:
        assert seed_name_from_path("prompt/v1.json") == "prompt:v1"

    def test_whitespace_stripped(self) -> None:
        assert seed_name_from_path("  prompt/v1.yaml  ") == "prompt:v1"

    def test_empty_raises(self) -> None:
        with pytest.raises(ValueError, match="empty seed path"):
            seed_name_from_path("")

    def test_only_seed_prefix_raises(self) -> None:
        with pytest.raises(ValueError, match="names no artifact"):
            seed_name_from_path("seed/", category="experiment")


# ---------------------------------------------------------------------------
# _artifact_path
# ---------------------------------------------------------------------------


class TestArtifactPath:
    def test_finds_yaml(self, tmp_path: Path) -> None:
        art_dir = tmp_path / "artifact" / "prompt" / "classification"
        art_dir.mkdir(parents=True)
        expected = art_dir / "v1.yaml"
        expected.write_text("type: prompt\ncontent: {}")

        result = _artifact_path(tmp_path, "prompt:classification:v1")
        assert result == expected

    def test_finds_yml(self, tmp_path: Path) -> None:
        art_dir = tmp_path / "artifact" / "prompt"
        art_dir.mkdir(parents=True)
        expected = art_dir / "v1.yml"
        expected.write_text("type: prompt\ncontent: {}")

        result = _artifact_path(tmp_path, "prompt:v1")
        assert result == expected

    def test_finds_json(self, tmp_path: Path) -> None:
        art_dir = tmp_path / "artifact" / "prompt"
        art_dir.mkdir(parents=True)
        expected = art_dir / "v1.json"
        expected.write_text('{"type": "prompt", "content": {}}')

        result = _artifact_path(tmp_path, "prompt:v1")
        assert result == expected

    def test_prefers_yaml_over_yml(self, tmp_path: Path) -> None:
        art_dir = tmp_path / "artifact" / "p"
        art_dir.mkdir(parents=True)
        (art_dir / "v.yaml").write_text("type: t\ncontent: {}")
        (art_dir / "v.yml").write_text("type: t\ncontent: {}")

        result = _artifact_path(tmp_path, "p:v")
        assert result.suffix == ".yaml"

    def test_missing_raises(self, tmp_path: Path) -> None:
        (tmp_path / "artifact").mkdir()
        with pytest.raises(FileNotFoundError, match="no seed file"):
            _artifact_path(tmp_path, "does:not:exist")


# ---------------------------------------------------------------------------
# _load_yaml_mapping
# ---------------------------------------------------------------------------


class TestLoadYamlMapping:
    def test_valid_mapping(self, tmp_path: Path) -> None:
        f = tmp_path / "m.yaml"
        f.write_text(yaml.dump({"key": "value"}))
        assert _load_yaml_mapping(f) == {"key": "value"}

    def test_non_dict_raises(self, tmp_path: Path) -> None:
        f = tmp_path / "list.yaml"
        f.write_text(yaml.dump([1, 2, 3]))
        with pytest.raises(ValueError, match="must be a YAML mapping"):
            _load_yaml_mapping(f)


# ---------------------------------------------------------------------------
# _read_experiment_file
# ---------------------------------------------------------------------------


class TestReadExperimentFile:
    def _write_experiment(self, root: Path, rel: str, body: str) -> Path:
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
        return path

    def test_parses_valid(self, tmp_path: Path) -> None:
        path = self._write_experiment(
            tmp_path,
            "experiment/baseline.yaml",
            "feature: classification\nconfig:\n  model: mistral-large\nartifacts:\n  - prompt:v1\n",
        )
        name, feature, config, arts = _read_experiment_file(path, tmp_path)
        assert name == "baseline"
        assert feature == "classification"
        assert config == {"model": "mistral-large"}
        assert arts == ["prompt:v1"]

    def test_nested_name(self, tmp_path: Path) -> None:
        path = self._write_experiment(
            tmp_path,
            "experiment/classif/v2.yaml",
            "feature: cls\nconfig: {}\n",
        )
        name, *_ = _read_experiment_file(path, tmp_path)
        assert name == "classif:v2"

    def test_defaults_empty_artifacts(self, tmp_path: Path) -> None:
        path = self._write_experiment(
            tmp_path,
            "experiment/simple.yaml",
            "feature: x\n",
        )
        _, _, config, arts = _read_experiment_file(path, tmp_path)
        assert arts == []
        assert config == {}

    def test_missing_feature_raises(self, tmp_path: Path) -> None:
        path = self._write_experiment(
            tmp_path,
            "experiment/bad.yaml",
            "config: {}\n",
        )
        with pytest.raises(ValueError, match="non-empty string 'feature'"):
            _read_experiment_file(path, tmp_path)

    def test_non_list_artifacts_raises(self, tmp_path: Path) -> None:
        path = self._write_experiment(
            tmp_path,
            "experiment/bad.yaml",
            "feature: x\nartifacts: oops\n",
        )
        with pytest.raises(ValueError, match="list of artifact-name strings"):
            _read_experiment_file(path, tmp_path)

    def test_non_dict_config_raises(self, tmp_path: Path) -> None:
        path = self._write_experiment(
            tmp_path,
            "experiment/bad.yaml",
            "feature: x\nconfig: 42\n",
        )
        with pytest.raises(ValueError, match="must be a mapping"):
            _read_experiment_file(path, tmp_path)


# ---------------------------------------------------------------------------
# _read_artifact_file
# ---------------------------------------------------------------------------


class TestReadArtifactFile:
    def _write_artifact(self, root: Path, rel: str, body: str) -> Path:
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
        return path

    def test_parses_valid(self, tmp_path: Path) -> None:
        path = self._write_artifact(
            tmp_path,
            "artifact/prompt/v1.yaml",
            "type: prompt\nscope: classification\ncontent:\n  template: Hello {name}\n",
        )
        name, art_type, scope, content = _read_artifact_file(path, tmp_path)
        assert name == "prompt:v1"
        assert art_type == "prompt"
        assert scope == "classification"
        assert content == {"template": "Hello {name}"}

    def test_defaults_empty_scope_and_content(self, tmp_path: Path) -> None:
        path = self._write_artifact(
            tmp_path,
            "artifact/sys.yaml",
            "type: system_prompt\n",
        )
        _, _, scope, content = _read_artifact_file(path, tmp_path)
        assert scope == ""
        assert content == {}

    def test_missing_type_raises(self, tmp_path: Path) -> None:
        path = self._write_artifact(
            tmp_path,
            "artifact/bad.yaml",
            "content: {}\n",
        )
        with pytest.raises(ValueError, match="non-empty string 'type'"):
            _read_artifact_file(path, tmp_path)

    def test_non_dict_content_raises(self, tmp_path: Path) -> None:
        path = self._write_artifact(
            tmp_path,
            "artifact/bad.yaml",
            "type: prompt\ncontent: just a string\n",
        )
        with pytest.raises(ValueError, match="must be a mapping"):
            _read_artifact_file(path, tmp_path)

    def test_non_string_scope_raises(self, tmp_path: Path) -> None:
        path = self._write_artifact(
            tmp_path,
            "artifact/bad.yaml",
            "type: prompt\nscope: [a, b]\n",
        )
        with pytest.raises(ValueError, match="must be a string"):
            _read_artifact_file(path, tmp_path)
