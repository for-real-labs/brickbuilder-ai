"""Compatible upstream additions reach the host without hand-written tools."""
import argparse
import asyncio
import json
from pathlib import Path

import pytest

from src.utils.nova_agent import TOOLS
from src.utils.nova_capabilities import CapabilityRegistry
from src.utils.nova_runtime_bridge import parser_capabilities
from src.utils.nova_toolkit import NovaToolkit


def future_manifest(styles=("gothic", "fantasy")):
    parser = argparse.ArgumentParser()
    families = parser.add_subparsers(dest="family", required=True)
    castle = families.add_parser("castle").add_subparsers(dest="feature", required=True)
    brief = castle.add_parser("brief", help="Study a newly added castle construction brief")
    brief.add_argument("archetype", choices=styles)
    return {"schema_version": 1, "compatible": True,
            "contract": {"compatible": True, "schema_sha256": "c" * 64},
            "plan_schema": {"type": "object"}, "capabilities": parser_capabilities(parser)}


def test_new_upstream_construction_tool_and_updated_choices_are_discovered(monkeypatch, tmp_path):
    toolkit = NovaToolkit(tmp_path)
    calls = []
    manifests = iter([future_manifest(), future_manifest(("gothic", "fantasy", "renaissance"))])

    async def bridge(command, operation):
        calls.append((command, operation))
        return next(manifests)

    monkeypatch.setattr(toolkit, "_run_process", bridge)
    asyncio.run(toolkit.prepare_capabilities())
    addition = next(tool for tool in toolkit.agent_tools(TOOLS) if tool.name == "nova_castle_brief")
    assert addition.schema["properties"]["archetype"]["enum"] == ["gothic", "fantasy"]
    asyncio.run(toolkit.prepare_capabilities())
    assert len(calls) == 1
    next_toolkit = NovaToolkit(tmp_path / "next-job")
    monkeypatch.setattr(next_toolkit, "_run_process", bridge)
    asyncio.run(next_toolkit.prepare_capabilities())
    next_tool = next(tool for tool in next_toolkit.agent_tools(TOOLS) if tool.name == "nova_castle_brief")
    assert "renaissance" in next_tool.schema["properties"]["archetype"]["enum"]


def test_generated_tool_invokes_fixed_bridge_with_data_and_captured_snapshot(monkeypatch, tmp_path):
    toolkit = NovaToolkit(tmp_path / "job", max_parts=300)
    toolkit.capabilities = CapabilityRegistry.from_manifest(future_manifest())
    toolkit.capability_manifest = toolkit.capabilities.manifest
    toolkit.agent_tools(TOOLS)
    requests = []

    async def bridge(command, operation, input_data=None):
        requests.append((command, operation, json.loads(input_data)))
        return {"capability": "castle.brief", "status": 0, "report": {"archetype": "gothic"}, "artifacts": []}

    monkeypatch.setattr(toolkit, "_run_process", bridge)
    report, image = asyncio.run(toolkit.dispatch("nova_castle_brief", {"archetype": "gothic"}, 1))
    command, operation, request = requests[0]
    assert Path(command[1]).name == "nova_runtime_bridge.py"
    assert command[command.index("--toolkit-root") + 1] == str(toolkit.root)
    assert command[command.index("--max-parts") + 1] == "300"
    assert request == {"capability": "castle.brief", "arguments": {"archetype": "gothic"}}
    assert operation == "capability" and image is None and report["status"] == 0
    assert toolkit.last_build is None
    assert toolkit.runtime_provenance()["used_capabilities"] == ["castle.brief"]
    assert len(toolkit.runtime_provenance()["capability_sha256"]) == 64


@pytest.mark.parametrize("arguments", [{"archetype": "unknown"}, {"archetype": "gothic", "output": "../../secret"}, {}])
def test_live_tool_schema_rejects_unsupported_arguments_before_starting_upstream(monkeypatch, tmp_path, arguments):
    toolkit = NovaToolkit(tmp_path)
    toolkit.capabilities = CapabilityRegistry.from_manifest(future_manifest())

    async def unexpected(*args, **kwargs):
        pytest.fail("invalid tool data reached an upstream process")

    monkeypatch.setattr(toolkit, "_run_process", unexpected)
    with pytest.raises(ValueError, match="capability schema"):
        asyncio.run(toolkit.invoke_capability("castle.brief", arguments))


def test_new_runtime_instruction_and_scoped_recipe_resource_can_be_paged(monkeypatch, tmp_path):
    root = tmp_path / "toolkit"
    root.mkdir()
    (root / "instructions.md").write_text("Latest upstream construction guide")
    monkeypatch.setenv("NOVA_TOOLKIT_ROOT", str(root))
    monkeypatch.delenv("NOVA_MANAGED_RUNTIME", raising=False)
    toolkit = NovaToolkit(tmp_path / "job")
    output = toolkit.workspace / "upstream" / "castle.plan"
    output.mkdir(parents=True)
    (output / "plan.json").write_text('{"sections": []}')
    assert toolkit.read_resource_page("instructions.md")["content"] == "Latest upstream construction guide"
    assert toolkit.read_resource("upstream/castle.plan/plan.json") == '{"sections": []}'
    secret = tmp_path / "secret.json"
    secret.write_text("private")
    (output / "escape.json").symlink_to(secret)
    with pytest.raises(ValueError, match="readable"):
        toolkit.read_resource("upstream/castle.plan/escape.json")


def test_generic_discovery_respects_disabled_jev_even_with_an_attached_key(monkeypatch, tmp_path):
    monkeypatch.setenv("TYPESAFE_API_KEY", "offline-test-key")
    parser = argparse.ArgumentParser()
    discover = parser.add_subparsers().add_parser("discover").add_subparsers()
    search = discover.add_parser("search")
    search.add_argument("kind", choices=["models", "submodels", "parts"])
    search.add_argument("query")
    search.add_argument("--engine", choices=["jev", "fts"], default="jev")
    manifest = future_manifest()
    manifest["capabilities"] = parser_capabilities(parser)
    toolkit = NovaToolkit(tmp_path, use_jev=False)
    toolkit.capabilities = CapabilityRegistry.from_manifest(manifest)
    requests = []

    async def bridge(command, operation, input_data=None):
        requests.append(json.loads(input_data))
        return {"capability": "discover.search", "status": 0, "report": {"engine": "fts"}, "artifacts": []}

    monkeypatch.setattr(toolkit, "_run_process", bridge)
    asyncio.run(toolkit.invoke_capability("discover.search", {"kind": "submodels", "query": "tower", "engine": "jev"}))
    assert requests[0]["arguments"]["engine"] == "fts"
