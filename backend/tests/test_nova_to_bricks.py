import asyncio
import io
import json
import zipfile
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from src.requests import novaToBricks as module
from src.utils.nova_toolkit import NovaBuild, NovaReference


def test_nova_request_preserves_inputs_and_enforces_limits():
    request = module.NovaToBricksRequest(prompt="  complete castle set  ", model="gpt-5.5", auth_mode="native")
    assert request.prompt == "complete castle set" and request.max_parts == 5000
    for extra in ({"max_parts": 10001}, {"max_iterations": 3}, {"auth_mode": "oauth-token"},
                  {"generation_id": "old-voxels"}):
        with pytest.raises(ValidationError):
            module.NovaToBricksRequest(prompt="castle", **extra)


def test_whole_generation_timeout_is_bounded(monkeypatch):
    for value in ("NaN", "infinity", "invalid", "-2", "999999"):
        monkeypatch.setenv("NOVA_TIMEOUT_SECONDS", value)
        assert module._generation_timeout() == 1800
    monkeypatch.setenv("NOVA_TIMEOUT_SECONDS", "300")
    assert module._generation_timeout() == 300


def test_source_archive_contains_rebuildable_plan_hierarchy_and_review():
    build = NovaBuild("flat-ldr", "hierarchy-mpd", {"version": 1}, {"checks_passed": True}, b"png")
    with zipfile.ZipFile(io.BytesIO(module._source_archive(build))) as archive:
        assert set(archive.namelist()) == {"model.plan.json", "model.mpd", "model.ldr", "inspection.json", "review.png", "README.txt"}
        assert archive.read("model.mpd") == b"hierarchy-mpd"


def test_source_archive_records_selected_upstream_revision_and_used_features():
    provenance = {"schema_version": 1, "toolkit_revision": "a" * 40, "jev_revision": "b" * 40,
                  "used_capabilities": ["vehicle.plan"], "capability_sha256": "c" * 64}
    build = NovaBuild("ldr", "mpd", {}, {}, b"png", runtime=provenance)
    with zipfile.ZipFile(io.BytesIO(module._source_archive(build))) as archive:
        assert json.loads(archive.read("runtime.json")) == provenance


def test_source_archive_keeps_original_reference_licence_geometry_and_provenance():
    identity = "submodel-" + "a" * 24
    metadata = {"model": "75954-1.mpd", "section": "75954 - Tower Roof Top.ldr", "source_sha256": "source-hash",
                "attribution": [{"author": "Stefan Frenz [smf]", "license": "CCAL version 2.0"}]}
    source = "0 FILE Original roof.ldr\n0 Author: Stefan Frenz [smf]\n"
    reference = NovaReference(identity, source, "preview-mpd", metadata, b"reference-png")
    build = NovaBuild("ldr", "mpd", {}, {}, b"png", (reference,))
    with zipfile.ZipFile(io.BytesIO(module._source_archive(build))) as archive:
        prefix = f"references/{identity}/"
        assert archive.read(prefix + "source.mpd").decode() == source
        assert archive.read(prefix + "review.png") == b"reference-png"
        assert archive.read(prefix + "preview.mpd") == b"preview-mpd"
        provenance = json.loads(archive.read(prefix + "provenance.json"))
        assert provenance["attribution"] == metadata["attribution"]
        assert provenance["source_resource"] == prefix + "source.mpd"
        assert provenance["metadata_resource"] == prefix + "provenance.json"
        assert json.loads(archive.read("references/index.json"))[0]["source_sha256"] == "source-hash"


def test_source_archive_rejects_reference_filename_escape_count_and_size_bombs():
    def build(references):
        return NovaBuild("ldr", "mpd", {}, {}, b"png", tuple(references))
    bad = NovaReference("../../secret", "source", "preview", {}, None)
    with pytest.raises(ValueError, match="identity"):
        module._source_archive(build([bad]))
    reference = NovaReference("submodel-" + "a" * 24, "source", "preview", {}, None)
    with pytest.raises(ValueError, match="Too many"):
        module._source_archive(build([reference] * 9))
    huge = NovaReference(reference.id, "x" * 32_000_001, "", {}, None)
    with pytest.raises(ValueError, match="budget"):
        module._source_archive(build([huge]))


def test_reference_archive_size_budget_includes_index_provenance(monkeypatch):
    monkeypatch.setattr(module, "MAX_REFERENCE_ARCHIVE_BYTES", 1000)
    reference = NovaReference("submodel-" + "a" * 24, "s", "p",
                              {"attribution": [{"author": "a" * 300}]}, None)
    build = NovaBuild("ldr", "mpd", {}, {}, b"png", (reference,))
    with pytest.raises(ValueError, match="budget"):
        module._source_archive(build)


def test_nova_source_rechecks_generation_ownership(monkeypatch):
    class Storage:
        async def get_generation(self, generation_id):
            return {"user_id": "owner", "user_type": "authenticated", "endpoint": "novaToBricks", "status": "completed"}

    monkeypatch.setattr(module, "generation_storage", Storage())
    with pytest.raises(HTTPException) as error:
        asyncio.run(module.get_nova_source("generation", {"user_id": "intruder", "is_anonymous": False}))
    assert error.value.status_code == 404


def test_nova_background_failure_does_not_charge_credits(monkeypatch):
    statuses, charges = [], []

    class Storage:
        async def update_status(self, generation_id, status, error_message=None):
            statuses.append((status, error_message))

    async def failed_build(*args):
        raise ValueError("Unresolved connection geometry")

    async def charge(**kwargs):
        charges.append(kwargs)

    monkeypatch.setattr(module, "generation_storage", Storage())
    monkeypatch.setattr(module, "build_set", failed_build)
    monkeypatch.setattr(module, "deduct_credits", charge)
    monkeypatch.setattr(module, "track_error", lambda **kwargs: None)
    request = module.NovaToBricksRequest(prompt="castle", model="gpt-5.5")
    error = asyncio.run(module.process_nova_to_bricks_task("generation", request, {"user_email": "test"}, {}))
    assert error == "Unresolved connection geometry"
    assert statuses[-1] == ("failed", error)
    assert charges == []


def test_nova_success_stores_model_parts_preview_and_portable_sources(monkeypatch, tmp_path):
    calls = []
    build = NovaBuild("flat-ldr", "hierarchical-mpd", {"version": 1}, {"checks_passed": True}, b"png")

    class Bucket:
        def upload(self, **kwargs):
            calls.append(("archive", kwargs["file"]))

    class Storage:
        client = SimpleNamespace(storage=SimpleNamespace(from_=lambda name: Bucket()))

        async def update_status(self, generation_id, status, error_message=None):
            calls.append(("status", status))

        async def store_model_file(self, generation_id, content, file_type, **kwargs):
            calls.append(("model", file_type, content))

        async def store_parts_list_csv(self, generation_id, content, **kwargs):
            calls.append(("parts", content))

        async def store_preview_image(self, generation_id, content):
            calls.append(("preview", content))

    class Packer:
        def __init__(self, **kwargs):
            pass

        def pack_ldraw_model(self, source):
            target = tmp_path / "packed.mpd"
            target.write_text("dependency-complete-mpd")
            return str(target)

    async def success_build(*args):
        return build

    async def charge(**kwargs):
        calls.append(("charge", kwargs["credits_to_deduct"]))

    monkeypatch.setattr(module, "generation_storage", Storage())
    monkeypatch.setattr(module, "build_set", success_build)
    monkeypatch.setattr(module, "LDrawPacker", Packer)
    monkeypatch.setattr(module, "deduct_credits", charge)
    monkeypatch.setattr(module, "track_image_conversion", lambda **kwargs: None)
    request = module.NovaToBricksRequest(prompt="castle", model="gpt-5.5")
    result = asyncio.run(module.process_nova_to_bricks_task("generation", request,
                        {"user_email": "test", "is_developer": False}, {}))
    assert result is None
    assert ("model", "ldr", "flat-ldr") in calls
    assert ("parts", "flat-ldr") in calls
    assert ("preview", b"png") in calls
    assert calls[-1] == ("status", "completed")
    archive_data = next(value for kind, value, *rest in calls if kind == "archive")
    with zipfile.ZipFile(io.BytesIO(archive_data)) as archive:
        assert archive.read("model.mpd") == b"hierarchical-mpd"
        assert archive.read("model-packed.mpd") == b"dependency-complete-mpd"
    assert ("charge", 1) in calls
