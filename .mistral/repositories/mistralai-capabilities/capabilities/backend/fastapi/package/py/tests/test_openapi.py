"""The codegen guard, against the schemas FastAPI really emits for each return annotation."""

from typing import Any, Literal

import pytest
from fastapi import FastAPI
from mistralai_capabilities.fastapi.openapi import untyped_json_responses
from pydantic import BaseModel


class Item(BaseModel):
    name: str


def _spec_for(annotation: Any) -> dict[str, Any]:
    app = FastAPI()

    async def endpoint() -> None:
        return None

    endpoint.__annotations__["return"] = annotation
    app.get("/thing")(endpoint)
    return app.openapi()


@pytest.mark.parametrize(
    "annotation",
    [
        pytest.param(Item, id="model"),
        pytest.param(list[Item], id="list-of-models"),
        pytest.param(Item | None, id="optional-model"),
        pytest.param(list[str], id="list-of-str"),
        pytest.param(str, id="str"),
        pytest.param(int, id="int"),
        pytest.param(bool, id="bool"),
        pytest.param(float | None, id="optional-float"),
        pytest.param(Literal["ok", "degraded"], id="literal"),
        pytest.param(dict[str, int], id="dict-of-int"),
        pytest.param(dict[str, Item], id="dict-of-models"),
        pytest.param(tuple[str, int], id="tuple"),
    ],
)
def test_typed_responses_pass(annotation: Any) -> None:
    assert untyped_json_responses(_spec_for(annotation)) == []


@pytest.mark.parametrize(
    "annotation",
    [
        pytest.param(Any, id="any"),
        pytest.param(dict, id="bare-dict"),
        pytest.param(dict[str, Any], id="dict-of-any"),
        pytest.param(list, id="bare-list"),
        pytest.param(list[Any], id="list-of-any"),
    ],
)
def test_untyped_responses_are_reported(annotation: Any) -> None:
    assert untyped_json_responses(_spec_for(annotation)) == ["GET /thing (200)"]


def test_non_json_and_error_responses_are_not_codegen_inputs() -> None:
    spec = {
        "paths": {
            "/": {"get": {"responses": {"200": {"content": {"text/plain": {"schema": {}}}}}}},
            "/x": {
                "post": {"responses": {"422": {"content": {"application/json": {"schema": {}}}}}},
                "parameters": [],
            },
        }
    }

    assert untyped_json_responses(spec) == []
