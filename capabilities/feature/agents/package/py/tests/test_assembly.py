"""`assemble_harness` against real on-disk contribution packages.

Each test writes the four kind packages under a fresh, uniquely named root package in ``tmp_path``, so
discovery runs exactly as it does in an app (``pkgutil`` + ``importlib``) and no two tests share
imported modules.
"""

import itertools
import sys
from collections.abc import Iterator
from pathlib import Path
from textwrap import dedent
from types import ModuleType

import pytest
from mistralai.agents import agents
from mistralai_capabilities.agents.assembly import assemble_harness

_KINDS = ("tools", "connectors", "hooks", "mcps")
_roots = itertools.count()

TOOL = """
from pydantic import BaseModel
from mistralai.agents import agents

class Args(BaseModel):
    q: str

@agents.tool(name={name!r}, description="A test tool.", input_schema=Args, model_access="direct")
async def handler(args: Args) -> str:
    return args.q

tool = handler
"""

CONNECTOR = """
from mistralai.agents import agents

connector = agents.connector({key!r})
"""

HOOK = """
from mistralai.agents import agents

class Noop(agents.Hook):
    pass

hook = Noop()
"""

MCP = """
from mistralai.agents import agents

mcp = agents.RemoteMCP(url="https://mcp.example.com/mcp")
"""


@pytest.fixture
def contributions(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator["Contributions"]:
    root = f"contrib_{next(_roots)}"
    monkeypatch.syspath_prepend(str(tmp_path))
    yield Contributions(tmp_path / root, root)
    for name in [name for name in sys.modules if name == root or name.startswith(f"{root}.")]:
        del sys.modules[name]


class Contributions:
    def __init__(self, path: Path, root: str) -> None:
        self.path, self.root = path, root
        for kind in _KINDS:
            (path / kind).mkdir(parents=True)
            (path / kind / "__init__.py").write_text("")
        (path / "__init__.py").write_text("")

    def add(self, kind: str, module: str, source: str) -> None:
        (self.path / kind / f"{module}.py").write_text(dedent(source))

    def packages(self) -> dict[str, ModuleType]:
        return {kind: __import__(f"{self.root}.{kind}", fromlist=["_"]) for kind in _KINDS}

    def assemble(self) -> agents.Harness:
        return assemble_harness(**self.packages())


def test_empty_packages_assemble_a_bare_harness(contributions: Contributions) -> None:
    harness = contributions.assemble()

    assert harness.tools == ()
    assert harness.connectors == ()
    assert harness.hooks == ()
    assert harness.mcps == {}


def test_every_kind_is_merged_into_the_harness(contributions: Contributions) -> None:
    contributions.add("tools", "lookup", TOOL.format(name="lookup"))
    contributions.add("connectors", "slack", CONNECTOR.format(key="slack"))
    contributions.add("hooks", "noop", HOOK)
    contributions.add("mcps", "docs", MCP)

    harness = contributions.assemble()

    assert [tool.name for tool in harness.tools] == ["lookup"]
    assert [slot.connector_name for slot in harness.connectors] == ["slack"]
    assert [type(hook).__name__ for hook in harness.hooks] == ["Noop"]
    assert list(harness.mcps) == ["docs"]


def test_contributions_are_merged_in_module_name_order(contributions: Contributions) -> None:
    for key in ("stripe", "box", "notion"):
        contributions.add("connectors", key, CONNECTOR.format(key=key))

    harness = contributions.assemble()

    assert [slot.connector_name for slot in harness.connectors] == ["box", "notion", "stripe"]


def test_a_none_slot_opts_out(contributions: Contributions) -> None:
    contributions.add("connectors", "gated", "connector = None\n")

    assert contributions.assemble().connectors == ()


def test_private_modules_are_not_contributions(contributions: Contributions) -> None:
    contributions.add("tools", "_shared", "HELPER = 1\n")

    assert contributions.assemble().tools == ()


def test_a_module_missing_its_slot_fails_loudly(contributions: Contributions) -> None:
    # The classic misfile: a connector module dropped into tools/.
    contributions.add("tools", "slack", CONNECTOR.format(key="slack"))

    with pytest.raises(TypeError, match=r"tools\.slack is a tool contribution but does not expose `tool`"):
        contributions.assemble()


def test_a_wrong_element_type_fails_loudly(contributions: Contributions) -> None:
    contributions.add("hooks", "guardrail", "hook = object()\n")

    with pytest.raises(TypeError, match=r"hooks\.guardrail: `hook` must be an agents\.Hook, got object"):
        contributions.assemble()


def test_a_duplicate_tool_name_fails_loudly(contributions: Contributions) -> None:
    contributions.add("tools", "first", TOOL.format(name="lookup"))
    contributions.add("tools", "second", TOOL.format(name="lookup"))

    with pytest.raises(ValueError, match=r"tools\.second: duplicate tool 'lookup'"):
        contributions.assemble()


def test_a_duplicate_connector_key_fails_loudly(contributions: Contributions) -> None:
    contributions.add("connectors", "slack", CONNECTOR.format(key="slack"))
    contributions.add("connectors", "slack_again", CONNECTOR.format(key="slack"))

    with pytest.raises(ValueError, match=r"connectors\.slack_again: duplicate connector 'slack'"):
        contributions.assemble()


def test_hooks_may_repeat_a_type(contributions: Contributions) -> None:
    contributions.add("hooks", "a", HOOK)
    contributions.add("hooks", "b", HOOK)

    assert len(contributions.assemble().hooks) == 2
