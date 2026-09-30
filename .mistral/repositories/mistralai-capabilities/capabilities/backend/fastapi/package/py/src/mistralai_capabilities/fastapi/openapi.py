"""Codegen guard for the OpenAPI document the web client is generated from.

The generated TypeScript client is only as typed as the spec: a route annotated ``-> Any`` (or with
no response model) emits an empty ``{}`` schema and its response silently becomes ``unknown`` in the
client. :func:`untyped_json_responses` lists every such response so an app's route tests can fail on
it. Pure functions over the spec dictionary, so they import no web framework.
"""

from collections.abc import Mapping
from typing import Any

HTTP_METHODS = frozenset({"get", "post", "put", "patch", "delete"})

# JSON Schema leaf types that generate a concrete TypeScript type (`string`, `number`, `boolean`).
# `null` alone is not one: a route returning only `None` has no body worth typing. `object` and
# `array` are containers and count only when what they contain is typed.
_PRIMITIVE_TYPES = frozenset({"string", "integer", "number", "boolean"})


def schema_is_typed(schema: Mapping[str, Any]) -> bool:
    """Whether a response schema resolves to a concrete type the client generator can name.

    A ``$ref`` to a model, a primitive leaf (``str``, ``int``, ``float``, ``bool``, an enum or a
    ``Literal``), an array of typed items, an object with declared properties or typed
    ``additionalProperties`` (``dict[str, Model]``), or a union with at least one typed member.
    ``{}`` (``Any``), a bare ``dict`` / ``list`` and ``None`` are not.
    """
    if not schema:
        return False
    if "$ref" in schema or "enum" in schema or "const" in schema:
        return True
    declared = schema.get("type")
    types = set(declared) if isinstance(declared, list) else {declared}
    if types & _PRIMITIVE_TYPES:
        return True
    if "array" in types or "items" in schema or "prefixItems" in schema:
        items = [schema["items"]] if isinstance(schema.get("items"), Mapping) else []
        items += [item for item in schema.get("prefixItems", []) if isinstance(item, Mapping)]
        return any(schema_is_typed(item) for item in items)
    if "object" in types:
        additional = schema.get("additionalProperties")
        return bool(schema.get("properties")) or (isinstance(additional, Mapping) and schema_is_typed(additional))
    return any(schema_is_typed(member) for key in ("allOf", "anyOf", "oneOf") for member in schema.get(key, []))


def untyped_json_responses(spec: Mapping[str, Any]) -> list[str]:
    """Every 2xx JSON response in ``spec`` whose schema is not typed, as ``"METHOD /path (code)"``.

    Non-JSON responses (the plain-text root, an SSE stream) have no ``application/json`` schema and
    are not codegen inputs, so they are skipped.
    """
    offenders: list[str] = []
    for path, item in spec.get("paths", {}).items():
        for method, operation in item.items():
            if method not in HTTP_METHODS:
                continue
            for code, response in operation.get("responses", {}).items():
                if not code.startswith("2"):
                    continue
                schema = response.get("content", {}).get("application/json", {}).get("schema")
                if schema is not None and not schema_is_typed(schema):
                    offenders.append(f"{method.upper()} {path} ({code})")
    return offenders
