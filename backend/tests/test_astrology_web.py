import asyncio
import json
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException, Response
from src.api import building_agents
from src.requests import astrologyToBricks as astrology
from src.requests import novaToBricks as nova

ACCOUNT = {
    "authenticated": True,
    "auth_method": "jwt",
    "user_email": "builder@example.test",
    "user_id": "builder",
}


@pytest.mark.parametrize(
    ("identity", "allowed"),
    [
        (ACCOUNT, True),
        ({**ACCOUNT, "user_email": "BUILDER@example.test"}, True),
        ({**ACCOUNT, "user_email": "outsider@example.test"}, False),
        ({**ACCOUNT, "authenticated": False}, False),
        ({**ACCOUNT, "auth_method": "api_key"}, False),
        ({**ACCOUNT, "is_anonymous": True}, False),
    ],
)
def test_private_setting_and_direct_api_use_the_same_gate(monkeypatch, identity, allowed):
    monkeypatch.setenv("ASTROLOGY_ALLOWED_EMAILS", " builder@example.test, alternate@example.test ")
    response = Response()
    assert asyncio.run(building_agents(response, identity)) == {
        "agents": ["nova", "astrology"] if allowed else ["nova"]
    }
    assert response.headers["Cache-Control"] == "private, no-store"
    if not allowed:
        admission = AsyncMock()
        monkeypatch.setattr(
            nova, "generation_storage", SimpleNamespace(create_generation=admission)
        )
        with pytest.raises(HTTPException) as denied:
            asyncio.run(
                nova.nova_to_bricks(
                    nova.NovaToBricksRequest(prompt="Build a red boat", building_agent="astrology"),
                    identity,
                )
            )
        assert denied.value.status_code == 403
        admission.assert_not_called()


def test_all_parts_starts_astrology_with_existing_billing_and_ownership(monkeypatch):
    monkeypatch.setenv("ASTROLOGY_ALLOWED_EMAILS", ACCOUNT["user_email"])
    monkeypatch.setenv("OPENAI_API_KEY", "test")
    create = AsyncMock(return_value="generation")
    monkeypatch.setattr(astrology, "generation_storage", SimpleNamespace(create_generation=create))
    monkeypatch.setattr(nova, "generation_storage", object())
    monkeypatch.setattr(astrology, "Renderer", Mock())
    monkeypatch.setattr(astrology, "handle_auth_and_tracking", Mock())

    def start(generation_id, work):
        assert generation_id == "generation"
        work.close()

    monkeypatch.setattr(astrology, "start_generation_task", start)
    monkeypatch.setattr(nova, "_nova_service", Mock(side_effect=AssertionError("Wrong agent")))
    request = nova.NovaToBricksRequest(building_agent="astrology", prompt="A boat under 70 pieces")
    response = asyncio.run(nova.nova_to_bricks(request, ACCOUNT))
    assert response.generation_id == "generation"
    fields = create.await_args.kwargs
    assert fields["endpoint"] == "novaToBricks"
    assert fields["model_3d"] == "astrology"
    assert fields["user_id"] == ACCOUNT["user_id"]
    assert fields["max_parts"] == 69


def test_astrology_revision_keeps_its_engine_and_accepts_only_owners(monkeypatch):
    source = {
        "id": "previous",
        "status": "completed",
        "model_used_3d": "astrology",
        "user_id": "other-owner",
        "user_type": "authenticated",
    }
    monkeypatch.setenv("ASTROLOGY_ALLOWED_EMAILS", ACCOUNT["user_email"])
    monkeypatch.setenv("OPENAI_API_KEY", "test")
    monkeypatch.setattr(
        nova, "generation_storage", SimpleNamespace(get_generation=AsyncMock(return_value=source))
    )
    monkeypatch.setattr(astrology, "generation_storage", object())
    request = nova.NovaToBricksRequest(prompt="Paint it blue", source_generation_id="previous")
    with pytest.raises(HTTPException) as denied:
        asyncio.run(nova.nova_to_bricks(request, ACCOUNT))
    assert denied.value.status_code == 404


def test_completed_job_exports_model_instructions_and_owner_design(monkeypatch):
    from src.astrology.assembly import assemble
    from src.utils.supplier_catalog import get_supplier_catalog

    program = {"boat": "box 4 0 0 0 2 3 1"}
    catalog = get_supplier_catalog()
    model = assemble(program, catalog, 20)
    bucket = Mock()
    storage = SimpleNamespace(
        client=SimpleNamespace(storage=SimpleNamespace(from_=lambda _: bucket)),
        update_status=AsyncMock(),
        store_model_file=AsyncMock(),
        store_parts_list_csv=AsyncMock(),
        store_preview_image=AsyncMock(),
    )
    monkeypatch.setattr(astrology, "generation_storage", storage)
    publish = AsyncMock()
    monkeypatch.setattr(astrology, "upload_artifact", publish)

    @asynccontextmanager
    async def client(_key):
        yield object()

    monkeypatch.setattr(astrology, "open_client", client)
    monkeypatch.setattr(
        astrology,
        "design",
        AsyncMock(
            return_value=SimpleNamespace(
                program=program,
                assembly=model,
                views=SimpleNamespace(front=b"preview"),
            )
        ),
    )
    request = nova.NovaToBricksRequest(prompt="A small boat", max_parts=20)
    asyncio.run(
        astrology._build(
            "build", request, None, None, None, "test", Mock(), on_progress=AsyncMock()
        )
    )
    saved = {call.kwargs["path"]: call.kwargs["file"] for call in publish.await_args_list}
    assert json.loads(saved[f"build/{astrology.DESIGN_FILE}"])["sections"] == program
    assert saved[f"build/{astrology.INSTRUCTIONS_FILE}"] == model.ldraw().encode()
    storage.store_model_file.assert_awaited_once_with(
        "build", model.ldraw(), "ldr", raise_on_error=True
    )
    storage.store_parts_list_csv.assert_awaited_once_with(
        "build", model.ldraw(), raise_on_error=True
    )
    storage.update_status.assert_awaited_with("build", "completed")
