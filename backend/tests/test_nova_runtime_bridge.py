"""Live-parser contract and future-feature invocation, with a fake upstream."""
import argparse
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from src.utils import nova_runtime_bridge as bridge
from src.utils.nova_capabilities import CapabilityRegistry


def parser_factory(*, future=False, broken=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--library")
    parser.add_argument("--shadow", action="append")
    parser.add_argument("--no-shadow", action="store_true")
    commands = parser.add_subparsers(dest="command", required=True)
    groups = {}
    for identity, names in bridge.CORE_COMMAND_ARGUMENTS.items():
        path = identity.split(".")
        if len(path) == 1:
            leaf = commands.add_parser(path[0], help="Core " + identity)
        else:
            if path[0] not in groups:
                family = commands.add_parser(path[0])
                groups[path[0]] = family.add_subparsers(dest=path[0] + "_command", required=True)
            leaf = groups[path[0]].add_parser(path[1], help="Core " + identity)
        for name in sorted(names):
            if broken == (identity, name, "missing"):
                continue
            positional = name in bridge.CORE_POSITIONALS
            options = {} if positional else {"required": name == "output" and identity in {"build", "vehicle.plan", "technic.plan"}}
            if name in bridge.CORE_BOOLEAN_ARGUMENTS:
                options = {"action": "store_true"}
            elif name in bridge.CORE_INTEGER_ARGUMENTS:
                options["type"] = int
                if name == "max_instances":
                    options["default"] = 100_000
                elif name == "limit":
                    options["default"] = 10
            if (identity, name) in bridge.CORE_OPTIONAL_POSITIONALS:
                options["nargs"] = "?"
            if (identity, name) in bridge.CORE_CHOICE_CONTRACT:
                options["choices"] = sorted(bridge.CORE_CHOICE_CONTRACT[identity, name])
                if not positional:
                    options["default"] = options["choices"][0]
            if broken == (identity, name, "type"):
                options["type"] = float
            if broken == (identity, name, "choices"):
                options["choices"] = ["unsupported"]
            leaf.add_argument(name if positional else "--" + name.replace("_", "-"), **options)
    if future:
        family = commands.add_parser("castle", help="Future castle constructions")
        leaves = family.add_subparsers(dest="castle_command", required=True)
        leaves.add_parser("list", help="List newly available castle recipes")
        plan = leaves.add_parser("plan", help="Create a castle recipe plan")
        plan.add_argument("name")
        plan.add_argument("--roof-style", choices=["cone", "onion", "spire"], default="cone")
        plan.add_argument("--output", required=True)
        plan.add_argument("--force", action="store_true")
        forbidden = leaves.add_parser("render")
        forbidden.add_argument("--outdir", required=True)
    return parser


@pytest.fixture
def runtime(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    schema = {"type": "object", "required": ["version", "author", "sections"],
              "properties": {"version": {"const": 1}, "author": {"type": "string"}, "sections": {"type": "array"}}}
    (data / "plan.schema.json").write_text(json.dumps(schema))
    calls = []

    def run(args):
        calls.append(args)
        print("debug must not become JSON")
        if args.command == "castle" and args.castle_command == "list":
            return {"recipes": ["gothic-turret", "onion-turret"]}, 0
        if args.command == "castle" and args.castle_command == "plan":
            plan = {"version": 1, "author": "Upstream Nova", "sections": [], "roof": args.roof_style}
            Path(args.output).write_text(json.dumps(plan))
            Path(args.output).with_suffix(".brief.json").write_text('{"title":"Castle brief"}')
            return {"plan": plan}, 0
        return {"checked": True}, 0

    return SimpleNamespace(cli=SimpleNamespace(parser=lambda: parser_factory(future=True), run=run),
                           common=SimpleNamespace(DATA=data, jsonable=lambda item: item), calls=calls)


def test_manifest_reads_live_parser_and_schema(runtime, tmp_path):
    manifest = bridge.build_manifest(tmp_path, tmp_path, runtime=runtime)
    registry = CapabilityRegistry.from_manifest(manifest)
    assert manifest["compatible"] is True
    assert manifest["contract"]["missing"] == []
    assert registry.plan_schema["properties"]["version"] == {"const": 1}
    assert registry.get("castle.plan")["parameters"]["properties"]["roof_style"]["enum"] == ["cone", "onion", "spire"]
    assert not any(item["id"] == "castle.render" for item in registry.available)
    assert runtime.calls == []


@pytest.mark.parametrize("broken, expected", [(("part", "code", "missing"), "argument:part.code"),
                                            (("inspect", "max_instances", "type"), "signature:inspect.max_instances"),
                                            (("search", "kind", "choices"), "choice:search.kind")])
def test_incompatible_core_api_is_rejected_before_activation(runtime, tmp_path, broken, expected):
    runtime.cli.parser = lambda: parser_factory(broken=broken)
    with pytest.raises(bridge.CompatibilityError) as error:
        bridge.build_manifest(tmp_path, tmp_path, runtime=runtime)
    assert expected in error.value.missing
    assert runtime.calls == []


def test_new_required_core_option_is_incompatible(runtime, tmp_path):
    def updated():
        parser = parser_factory()
        root = next(action for action in parser._actions if isinstance(action, argparse._SubParsersAction))
        root.choices["build"].add_argument("--compiler-policy", required=True)
        return parser
    runtime.cli.parser = updated
    with pytest.raises(bridge.CompatibilityError) as error:
        bridge.build_manifest(tmp_path, tmp_path, runtime=runtime)
    assert "new-required-argument:build.compiler_policy" in error.value.missing


@pytest.mark.parametrize("mutation", [{"required": []}, {"properties": {"version": {"const": 2}}}, {"$ref": "https://example.com/schema.json"}])
def test_breaking_or_external_plan_schema_is_rejected(runtime, tmp_path, mutation):
    path = runtime.common.DATA / "plan.schema.json"
    schema = json.loads(path.read_text())
    schema.update(mutation)
    path.write_text(json.dumps(schema))
    with pytest.raises(bridge.CompatibilityError):
        bridge.build_manifest(tmp_path, tmp_path, runtime=runtime)


def test_future_feature_is_invoked_using_upstream_functions_and_scoped_outputs(runtime, tmp_path, capsys):
    job = tmp_path / "job"
    job.mkdir()
    (job / "model.plan.json").write_text("accepted original")
    result = bridge.invoke(tmp_path, tmp_path, job, {"capability": "castle.plan", "arguments": {"name": "gothic-turret", "roof_style": "spire"}}, runtime=runtime)
    assert result["report"]["plan"]["roof"] == "spire"
    assert runtime.calls[-1].roof_style == "spire"
    assert len(result["artifacts"]) == 2
    assert all(item["path"].startswith("upstream/castle.plan/") for item in result["artifacts"])
    assert (job / "model.plan.json").read_text() == "accepted original"
    assert "debug" not in capsys.readouterr().out


def test_new_recipe_names_pass_through_without_a_hardcoded_recipe_list(runtime, tmp_path):
    result = bridge.invoke(tmp_path, tmp_path, tmp_path, {"capability": "castle.list", "arguments": {}}, runtime=runtime)
    assert result["report"]["recipes"] == ["gothic-turret", "onion-turret"]


def test_unsafe_future_output_default_is_replaced_with_private_resource(runtime, tmp_path):
    def updated():
        parser = parser_factory(future=True)
        root = next(action for action in parser._actions if isinstance(action, argparse._SubParsersAction))
        castle = next(action for action in root.choices["castle"]._actions if isinstance(action, argparse._SubParsersAction))
        leaf = castle.choices["plan"]
        leaf.add_argument("--report", default="/outside/result.json")
        return parser
    runtime.cli.parser = updated
    result = bridge.invoke(tmp_path, tmp_path, tmp_path, {"capability": "castle.plan", "arguments": {"name": "turret"}}, runtime=runtime)
    assert Path(runtime.calls[-1].report).is_relative_to(tmp_path / "upstream" / "castle.plan")
    assert result["status"] == 0


def test_oversized_failed_outputs_are_removed_without_deleting_previous_artifacts(runtime, tmp_path, monkeypatch):
    existing = tmp_path / "upstream" / "vehicle.plan" / "previous.json"
    existing.parent.mkdir(parents=True)
    existing.write_text("previous")
    monkeypatch.setattr("src.utils.nova_capabilities.MAX_ARTIFACT_BYTES", 200)

    def oversized(args):
        Path(args.output).write_text("x" * 500)
        return {}, 0
    runtime.cli.run = oversized
    with pytest.raises(ValueError, match="size limit"):
        bridge.invoke(tmp_path, tmp_path, tmp_path, {"capability": "castle.plan", "arguments": {"name": "turret"}}, runtime=runtime)
    assert existing.read_text() == "previous"
    assert not list((tmp_path / "upstream" / "castle.plan").rglob("*.json"))


def test_large_pair_analysis_is_rejected_before_upstream_invocation(runtime, tmp_path):
    source = tmp_path / "source.mpd"
    source.write_text("0 safe source")
    with pytest.raises(ValueError, match="500-instance"):
        bridge.invoke(tmp_path, tmp_path, tmp_path, {"capability": "inspect", "arguments": {"file": "source.mpd", "contacts": "all"}}, max_parts=5000, runtime=runtime)
    assert not runtime.calls


def test_main_does_not_echo_upstream_exception_secrets(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(bridge, "build_manifest", lambda *_args: (_ for _ in ()).throw(RuntimeError("sk-secret-token /Users/private.env")))
    monkeypatch.setattr("sys.argv", ["bridge", "--toolkit-root", str(tmp_path), "--library", str(tmp_path), "--operation", "manifest"])
    assert bridge.main() == 2
    output = capsys.readouterr().out
    assert json.loads(output)["compatible"] is False
    assert "sk-secret" not in output
    assert "private.env" not in output


def test_manifest_checks_reference_adapter_import_contract(monkeypatch, tmp_path):
    modules = {}
    for name, attributes in bridge.CORE_IMPORTS.items():
        modules[name] = SimpleNamespace(**{attribute: object() for attribute in attributes})
    del modules["ldraw_tools.document"].physical_context
    modules["ldraw_tools.cli"] = SimpleNamespace(parser=lambda: None, run=lambda _args: None)
    monkeypatch.setattr(bridge.importlib, "import_module", lambda name: modules[name])
    with pytest.raises(bridge.CompatibilityError) as error:
        bridge._runtime(tmp_path)
    assert "ldraw_tools.document.physical_context" in error.value.missing
