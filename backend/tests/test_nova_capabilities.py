"""Policy regressions for the live Nova facade, without an installed toolkit."""
from pathlib import Path

import pytest

from src.utils.nova_capabilities import (
    CapabilityRegistry, ResourceBroker, capability_permission, command_parameters,
    safe_argument_argv,
)


def argument(name, *, type="string", choices=None, default=None, required=False,
             positional=False, action="store", nargs=None, path_role=None):
    row = {"name": name, "type": type, "converter": "int" if type == "integer" else "float" if type == "number" else "bool" if type == "boolean" else "str",
           "choices": choices, "required": required, "option_strings": [] if positional else ["--" + name.replace("_", "-")],
           "action": action, "nargs": nargs, "path_role": path_role}
    if default is not None:
        row["default"] = default
    return row


def capability(command, arguments):
    allowed, reason = capability_permission(command, arguments)
    return {"id": ".".join(command), "command": command, "description": "A live construction feature",
            "available": allowed, "reason": reason, "arguments": arguments, "parameters": command_parameters(arguments)}


@pytest.fixture
def broker(tmp_path):
    root, library, workspace = (tmp_path / name for name in ("nova", "ldraw", "job"))
    for directory in (root / "examples", root / "data" / "models-annotated", library / "parts", workspace):
        directory.mkdir(parents=True)
    return ResourceBroker(root, library, workspace, "castle.plan")


def test_future_family_enum_and_recipe_are_allowed_without_adapter_changes():
    row = capability(["castle", "plan"], [argument("name", positional=True, required=True),
                                          argument("roof_style", choices=["cone", "onion"]),
                                          argument("output", required=True, path_role="write_file")])
    registry = CapabilityRegistry.from_manifest({"schema_version": 1, "compatible": True, "plan_schema": {}, "capabilities": [row]})
    assert registry.get("castle.plan") == row
    assert registry.catalog("castle construction") == [row]
    assert row["parameters"]["properties"]["roof_style"]["enum"] == ["cone", "onion"]
    assert "output" not in row["parameters"]["properties"]
    assert row["parameters"]["required"] == ["name"]


@pytest.mark.parametrize("command", [["render"], ["glb"], ["doctor"], ["build"], ["extract"], ["manual", "prepare"],
                                    ["mechanism", "export"], ["discover", "prepare"], ["python", "list"],
                                    ["castle", "shell"], ["castle", "maintenance", "plan"]])
def test_external_process_and_mutation_commands_are_not_exposed(command):
    assert capability_permission(command, [])[0] is False


@pytest.mark.parametrize("name", ["filename", "destination", "source", "target", "state", "custom_path", "notes", "command", "api_key", "save_to"])
def test_unknown_file_or_process_options_fail_closed(name):
    assert capability_permission(["castle", "plan"], [argument(name)])[0] is False


def test_unknown_free_text_and_parser_converters_fail_closed():
    assert not capability_permission(["castle", "plan"], [argument("unclassified")])[0]
    option = argument("name")
    option["converter"] = "FileType"
    assert not capability_permission(["castle", "plan"], [option])[0]


def test_optional_implicit_read_resource_is_not_exposed():
    assert not capability_permission(["technic", "check"], [argument("contract", default="/outside/private.json", path_role="read_json")])[0]


@pytest.mark.parametrize("value", ["../outside.json", "/tmp/outside.json", "a/../../model.mpd", "a\\outside.json", "./model.mpd", "--report=x.json"])
def test_output_paths_cannot_escape_namespace(broker, value):
    with pytest.raises(ValueError):
        broker.resolve(value, "write_file")


def test_broker_keeps_host_build_and_companion_outputs_separate(broker):
    host = broker.workspace / "model.plan.json"
    host.write_text("accepted host plan")
    output = Path(broker.resolve("model.plan.json", "write_file"))
    output.write_text("upstream plan")
    output.with_suffix(".brief.json").write_text("brief")
    assert host.read_text() == "accepted host plan"
    assert output.is_relative_to(broker.workspace / "upstream" / "castle.plan")
    assert len(broker.artifacts()) == 2


def test_broker_rejects_symlink_output_and_source_escape(broker, tmp_path):
    private = tmp_path / "private.mpd"
    private.write_text("private")
    (broker.toolkit_root / "examples" / "escape.mpd").symlink_to(private)
    with pytest.raises(ValueError):
        broker.resolve("examples/escape.mpd", "read_source")
    broker.output_root.parent.mkdir(parents=True)
    broker.output_root.symlink_to(tmp_path)
    with pytest.raises(ValueError):
        broker.resolve("model.json", "write_file")


def test_broker_reads_only_named_bundled_or_job_source(broker):
    source = broker.toolkit_root / "data" / "models-annotated" / "75954-1.mpd"
    source.write_text("0 Hogwarts source")
    assert broker.resolve("data/models-annotated/75954-1.mpd", "read_source") == str(source)
    (broker.workspace / "secret.env").write_text("secret")
    with pytest.raises(ValueError):
        broker.resolve("secret.env", "read_source")
    (broker.workspace / "contract.json").write_text('{"includes":["/outside/private.json"]}')
    with pytest.raises(ValueError):
        broker.resolve("contract.json", "read_json")


def test_defaults_are_clamped_and_required_outputs_are_automatic(broker):
    row = capability(["castle", "plan"], [argument("name", positional=True, required=True),
                                          argument("max_instances", type="integer", default=100_000),
                                          argument("output", required=True, path_role="write_file"),
                                          argument("report", default="/outside/report.json", path_role="write_file")])
    argv = safe_argument_argv(row, {"name": "turret"}, broker, max_parts=250)
    assert argv[:3] == ["castle", "plan", "turret"]
    assert argv[argv.index("--max-instances") + 1] == "250"
    assert Path(argv[argv.index("--output") + 1]).is_relative_to(broker.output_root)
    assert Path(argv[argv.index("--report") + 1]).is_relative_to(broker.output_root)


@pytest.mark.parametrize("values", [{"query": "--report=/outside"}, {"query": "normal", "raw_argv": ["--output", "/outside"]},
                                   {"query": "normal", "candidates": 0}, {"query": "normal", "limit": True}])
def test_option_injection_and_unbounded_search_budgets_are_rejected(broker, values):
    row = capability(["castle", "search"], [argument("query", positional=True, required=True),
                                            argument("candidates", type="integer", default=500), argument("limit", type="integer", default=10)])
    with pytest.raises(ValueError):
        safe_argument_argv(row, values, broker)


def test_negative_numeric_angles_and_live_fixed_arrays_are_supported(broker):
    row = capability(["matrix"], [argument("axis", choices=["x", "y", "z"], positional=True, required=True),
                                 argument("degrees", type="number", positional=True, required=True),
                                 argument("size", type="number", nargs=3)])
    assert safe_argument_argv(row, {"axis": "y", "degrees": -90, "size": [1, 2, 3]}, broker) == ["matrix", "y", "-90", "--size", "1", "2", "3"]


def test_large_all_pairs_inspection_is_rejected(broker):
    row = capability(["inspect"], [argument("contacts", choices=["auto", "all", "none"], default="all"),
                                  argument("max_instances", type="integer", default=100_000)])
    with pytest.raises(ValueError, match="500-instance"):
        safe_argument_argv(row, {"contacts": "all"}, broker, max_parts=5000)
    argv = safe_argument_argv(row, {}, broker, max_parts=5000)
    assert argv[argv.index("--contacts") + 1] == "auto"


def test_artifact_limits_apply_to_every_capability_namespace(broker, monkeypatch):
    other = broker.workspace / "upstream" / "vehicle.plan" / "large.json"
    other.parent.mkdir(parents=True)
    other.write_text("x" * 101)
    monkeypatch.setattr("src.utils.nova_capabilities.MAX_ARTIFACT_BYTES", 100)
    with pytest.raises(ValueError, match="size limit"):
        broker.artifacts()


def test_registry_rejects_forged_supported_permissions():
    row = capability(["render"], [])
    row["available"] = True
    with pytest.raises(ValueError, match="permission"):
        CapabilityRegistry.from_manifest({"schema_version": 1, "compatible": True, "capabilities": [row]})


def test_manifest_version_must_be_an_integer_protocol_version():
    with pytest.raises(ValueError, match="incompatible"):
        CapabilityRegistry.from_manifest({"schema_version": True, "compatible": True, "capabilities": []})
