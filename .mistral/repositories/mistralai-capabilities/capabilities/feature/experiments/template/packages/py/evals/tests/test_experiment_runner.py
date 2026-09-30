from evals.experiment_runner import (
    EvaluateExperimentRequest,
    EvaluateExperimentResult,
    ExperimentPlan,
    ResolvedExperiment,
    ScoreFromRunExperimentRequest,
)


def test_resolved_experiment_defaults() -> None:
    r = ResolvedExperiment()
    assert r.config == {}
    assert r.artifacts == {}
    assert r.client is None


def test_resolved_experiment_with_values() -> None:
    r = ResolvedExperiment(config={"k": "v"}, artifacts={"a": {"x": 1}}, client="fake")
    assert r.config == {"k": "v"}
    assert r.artifacts["a"] == {"x": 1}
    assert r.client == "fake"


def test_evaluate_experiment_request_required_fields() -> None:
    req = EvaluateExperimentRequest(feature="search", experiment_name="v1")
    assert req.feature == "search"
    assert req.experiment_name == "v1"
    assert req.dataset is None
    assert req.local is False
    assert req.collection_name is None


def test_evaluate_experiment_request_all_fields() -> None:
    req = EvaluateExperimentRequest(
        feature="search", experiment_name="v1", dataset="ds", local=True, collection_name="col"
    )
    assert req.local is True
    assert req.dataset == "ds"
    assert req.collection_name == "col"


def test_score_from_run_experiment_request() -> None:
    req = ScoreFromRunExperimentRequest(feature="f", experiment_name="e")
    assert req.source_run_id is None
    assert req.source_config_digest is None
    assert req.dataset is None
    assert req.collection_name is None


def test_experiment_plan_defaults() -> None:
    plan = ExperimentPlan(feature="f", experiment_name="e", dataset_name="d")
    assert plan.records == []
    assert plan.config == {}
    assert plan.artifacts == {}


def test_experiment_plan_with_data() -> None:
    plan = ExperimentPlan(
        feature="f",
        experiment_name="e",
        dataset_name="d",
        records=[{"q": "hi"}],
        config={"k": 1},
        artifacts={"a": {"body": "text"}},
    )
    assert len(plan.records) == 1
    assert plan.config["k"] == 1


def test_evaluate_experiment_result_defaults() -> None:
    res = EvaluateExperimentResult(feature="f", experiment_name="e", dataset="d")
    assert res.scores == {}
    assert res.passed is None
    assert res.dataset_size == 0
    assert res.run_id == ""
    assert res.studio_run_id is None


def test_evaluate_experiment_result_with_scores() -> None:
    res = EvaluateExperimentResult(
        feature="f",
        experiment_name="e",
        dataset="d",
        scores={"accuracy": 0.95},
        passed=True,
        dataset_size=100,
        run_id="run-1",
        studio_run_id="studio-1",
    )
    assert res.scores["accuracy"] == 0.95
    assert res.passed is True
    assert res.dataset_size == 100
