"""Reference identities, source preservation and bounded actual-mesh studies."""
import asyncio
import hashlib
import io
import json
from types import SimpleNamespace
from pathlib import Path

import pytest
from PIL import Image

from src.utils.nova_reference_bridge import prepare_reference
from src.utils.nova_toolkit import MAX_REPORT_CHARS, NovaToolkit, serialize_feedback

ROOF_ID = "submodel-ca689c04dff4ff24a8aaf200"
MODEL_ID = "model-" + "a" * 24
ROOF_NAME = "75954 - Tower Roof Top.ldr"
PARTS = ["48310.dat", "3660.dat", "3245c.dat", "38317.dat", "3942c.dat", "59900.dat", "90540.dat"]
SOURCE = ("0 FILE " + ROOF_NAME + "\n0 Author: Stefan Frenz [smf]\n"
          "0 !LICENSE Redistributable under CCAL version 2.0 : see CAreadme.txt\n" +
          "\n".join(f"1 {16 if number == 0 else 72} 0 {-24 * number} 0 1 0 0 0 1 0 0 0 1 {part}" for number, part in enumerate(PARTS)) + "\n0 NOFILE\n")


def reference_runtime(tmp_path):
    root = tmp_path / "toolkit"
    corpus = root / "data" / "models-annotated"
    corpus.mkdir(parents=True)
    path = corpus / "75954-1.mpd"
    path.write_text(SOURCE)
    selected = SimpleNamespace(name=ROOF_NAME, description="Nested half-cones topped with a sand-green ski-pole finial.")
    row = {"id": ROOF_ID, "kind": "submodels", "model": path.name, "section": ROOF_NAME,
           "source_sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    inventory = {"expanded_leaf_count": 7, "physical_placements": 7, "physical_accounting_complete": True,
                 "bom": [{"part": part, "count": 1, "physical_index_entry": True} for part in PARTS],
                 "parents": [{"section": "75954 - Tower.ldr", "colour": 378}],
                 "dependencies": [{"section": ROOF_NAME, "kind": "assembly", "author": "Stefan Frenz [smf]", "license": "CCAL version 2.0"}]}
    calls = []

    class Index:
        def __init__(self, parts):
            pass

        def ensure(self):
            calls.append("ensure")

        def get(self, identity):
            calls.append(identity)
            return dict(row)

        def inventory(self, requested, max_instances):
            assert requested["id"] == ROOF_ID and requested["section"] == ROOF_NAME
            assert max_instances == 10_000
            return inventory

    def selected_source(requested, section, colour=None):
        assert requested == path and section == ROOF_NAME
        return ((f"0 FILE preview-root.ldr\n1 {colour} 0 0 0 1 0 0 0 1 0 0 0 1 {section}\n" if colour is not None else "") + SOURCE), {}

    runtime = SimpleNamespace(get_parts=lambda library: object(), DiscoveryIndex=Index,
                              normalized=lambda text: text.replace("\\", "/").casefold(),
                              parse_source=lambda requested: selected, resolve_section=lambda model, section: selected,
                              source_id=lambda kind, **kwargs: ROOF_ID if kind == "submodels" else MODEL_ID,
                              selected_source=selected_source)
    return root, path, runtime, row, inventory, calls


def test_discovered_hogwarts_roof_keeps_identity_actual_bom_namespace_and_author(tmp_path):
    root, path, runtime, _, _, calls = reference_runtime(tmp_path)
    result = prepare_reference(root, tmp_path / "library", ROOF_ID, runtime=runtime)
    metadata = result["metadata"]
    assert calls == ["ensure", ROOF_ID]
    assert metadata["id"] == ROOF_ID and metadata["model"] == "75954-1.mpd" and metadata["section"] == ROOF_NAME
    assert [row["part"] for row in metadata["inventory"]["bom"]] == PARTS
    assert metadata["attribution"][0]["author"] == "Stefan Frenz [smf]"
    assert result["source_mpd"] == SOURCE and f"1 378 0 0 0" in result["preview_mpd"]
    assert metadata["preview_colour"] == 378 and metadata["preview_colour_origin"] == "source_parent"
    assert metadata["source_sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()
    assert str(tmp_path) not in json.dumps(metadata)


def test_preview_default_and_explicit_colour_are_labeled_without_rewriting_source(tmp_path):
    root, _, runtime, _, inventory, _ = reference_runtime(tmp_path)
    inventory["parents"] = [{"colour": 4}, {"colour": 5}, {"colour": 16}]
    result = prepare_reference(root, tmp_path, ROOF_ID, runtime=runtime)
    assert result["metadata"]["preview_colour_origin"] == "preview_default"
    assert result["metadata"]["preview_colour"] == 7
    assert result["source_mpd"] == SOURCE
    explicit = prepare_reference(root, tmp_path, ROOF_ID, colour=0x2123456, runtime=runtime)
    assert explicit["metadata"]["preview_colour"] == 0x2123456
    assert explicit["metadata"]["preview_colour_origin"] == "explicit_preview"


def test_reference_rejects_changed_mismatched_or_escaping_source(tmp_path):
    root, path, runtime, row, _, _ = reference_runtime(tmp_path)
    with pytest.raises(ValueError, match="does not match"):
        prepare_reference(root, tmp_path, ROOF_ID, section="Different roof.ldr", runtime=runtime)
    row["id"] = MODEL_ID
    with pytest.raises(ValueError, match="different reference"):
        prepare_reference(root, tmp_path, ROOF_ID, runtime=runtime)
    row["id"] = ROOF_ID
    path.write_text(SOURCE + "0 changed\n")
    with pytest.raises(ValueError, match="changed since indexing"):
        prepare_reference(root, tmp_path, ROOF_ID, runtime=runtime)
    with pytest.raises(ValueError, match="bundled"):
        prepare_reference(root, tmp_path, "../../secret.mpd", runtime=runtime)
    external = tmp_path / "secret.mpd"
    external.write_text(SOURCE)
    (path.parent / "escape.mpd").symlink_to(external)
    with pytest.raises(ValueError, match="bundled"):
        prepare_reference(root, tmp_path, "escape.mpd", runtime=runtime)
    with pytest.raises(ValueError, match="not found"):
        prepare_reference(root, tmp_path, "missing.mpd", runtime=runtime)


@pytest.mark.parametrize("options", [{"max_instances": 10001}, {"max_instances": True}, {"colour": 16}, {"colour": 24}, {"colour": -1}, {"section": "\x00bad"}])
def test_reference_validates_bounds_before_loading_runtime(tmp_path, options):
    with pytest.raises(ValueError):
        prepare_reference(tmp_path, tmp_path, ROOF_ID, **options)


def test_tool_reference_returns_two_mesh_views_and_readable_private_source(monkeypatch, tmp_path):
    root, _, runtime, _, _, _ = reference_runtime(tmp_path)
    prepared = prepare_reference(root, tmp_path, ROOF_ID, runtime=runtime)
    library = tmp_path / "library"
    (library / "parts").mkdir(parents=True)
    (library / "p").mkdir()
    (library / "LDConfig.ldr").write_text("0 !COLOUR Sand_Green CODE 378 VALUE #A0BCAC EDGE #333333\n0 !COLOUR Dark_Grey CODE 72 VALUE #606060 EDGE #333333")
    for part in PARTS:
        (library / "parts" / part).write_text("3 16 -10 0 -10 10 0 -10 0 -20 10\n")
    monkeypatch.setenv("NOVA_TOOLKIT_ROOT", str(root))
    monkeypatch.setenv("LDRAW_DIR", str(library))
    toolkit = NovaToolkit(tmp_path / "job")
    commands = []

    async def extract(command, operation):
        commands.append(command)
        assert operation == "inspect_reference"
        directory = Path(command[command.index("--output") + 1])
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "source.mpd").write_text(prepared["source_mpd"])
        (directory / "preview.mpd").write_text(prepared["preview_mpd"])
        (directory / "metadata.json").write_text(json.dumps(prepared["metadata"]))
        return {"written": True, "id": ROOF_ID}

    monkeypatch.setattr(toolkit, "_run_process", extract)
    report, png = asyncio.run(toolkit.dispatch("inspect_reference", {"id": ROOF_ID}, 0))
    assert len(commands) == 1 and "nova_reference_bridge.py" in commands[0][1]
    assert png and Image.open(io.BytesIO(png)).size == (1200, 600)
    assert report["geometry"]["complete"] is True and report["geometry"]["part_count"] == 7
    assert report["geometry"]["triangle_count"] == 7
    assert report["geometry"]["rendered_colours"] == [72, 378]
    assert report["geometry"]["bounds"] == {"min": [-10.0, -164.0, -10.0], "max": [10.0, 0.0, 10.0]}
    assert toolkit.read_resource(report["source_resource"]) == SOURCE
    assert toolkit.references[ROOF_ID].preview_png == png
    assert [row["part"] for row in report["inventory"]["bom"]] == PARTS
    serialized = json.loads(serialize_feedback(report))
    assert serialized["geometry"]["triangle_count"] == 7 and serialized["geometry"]["rendered_colours"] == [72, 378]
    metadata = json.loads(toolkit.read_resource(report["metadata_resource"]))
    assert metadata["inventory"]["expanded_leaf_count"] == 7

    # A large inventory is compacted for the model, while its complete BOM is
    # available through an explicit resource cursor rather than a guessed path.
    prepared["metadata"]["inventory"]["bom"] *= 30
    report, _ = asyncio.run(toolkit.dispatch("inspect_reference", {"id": ROOF_ID}, 1))
    assert report["inventory"]["bom_omitted"] is True and report["inventory"]["bom_total_rows"] == 210
    encoded = serialize_feedback(report)
    assert len(encoded) <= MAX_REPORT_CHARS and json.loads(encoded)["id"] == ROOF_ID
    page = toolkit.read_resource_page(report["metadata_resource"])
    pages = page["content"]
    while page["next_offset"] is not None:
        page = toolkit.read_resource_page(report["metadata_resource"], page["next_offset"])
        pages += page["content"]
    assert len(json.loads(pages)["inventory"]["bom"]) == 210

    def missing_mesh(*args, **kwargs):
        raise ValueError("Library geometry missing: missing.dat")

    monkeypatch.setattr(toolkit.renderer, "render_mpd", missing_mesh)
    report, missing_png = asyncio.run(toolkit.dispatch("inspect_reference", {"id": ROOF_ID}, 2))
    assert missing_png is None and report["geometry"]["complete"] is False
    assert "missing.dat" in json.loads(serialize_feedback(report))["geometry"]["diagnostics"][0]["message"]
    assert "smaller discovered submodel" in report["instruction"]
    assert toolkit.references[ROOF_ID].preview_png is None
    toolkit.reference_inspections = 16
    with pytest.raises(ValueError, match="sixteen"):
        asyncio.run(toolkit.inspect_reference(ROOF_ID))
    assert len(commands) == 3


def test_full_model_and_fts_path_section_share_canonical_identity(monkeypatch, tmp_path):
    from src.utils import nova_reference_bridge
    root, path, runtime, row, inventory, _ = reference_runtime(tmp_path)
    monkeypatch.setattr(nova_reference_bridge, "_inventory", lambda *args: inventory)
    by_path = prepare_reference(root, tmp_path, str(path.relative_to(root)), section=ROOF_NAME, runtime=runtime)
    assert by_path["metadata"]["id"] == ROOF_ID and by_path["source_mpd"] == SOURCE
    row.update(id=MODEL_ID, kind="models")
    row.pop("section")
    runtime.DiscoveryIndex.inventory = lambda self, requested, max_instances: inventory
    full = prepare_reference(root, tmp_path, MODEL_ID, runtime=runtime)
    assert full["metadata"]["id"] == MODEL_ID and full["metadata"]["kind"] == "models"
    assert full["metadata"]["inventory"]["expanded_leaf_count"] == 7


def test_reference_source_reader_does_not_follow_workspace_symlinks(tmp_path):
    toolkit = NovaToolkit(tmp_path / "job")
    directory = toolkit.workspace / "references"
    directory.mkdir(parents=True)
    outside = tmp_path / "secret.json"
    outside.write_text("private")
    (directory / "escape.json").symlink_to(outside)
    with pytest.raises(ValueError, match="readable"):
        toolkit.read_resource("references/escape.json")
