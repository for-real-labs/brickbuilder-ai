import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException

from src.requests import getGenerationsByImage as history
from src.requests import updateModel as manual
from src.requests import promptEditModel as image_edit
from src.requests import llmToBricks as llm
from src.requests import getGeneration as generation_endpoint
from src.utils.generation_storage import GenerationStorage


@pytest.mark.parametrize("owner_type", ["anonymous", "authenticated"])
def test_history_uses_shared_id_for_image_free_model_and_scopes_owner(monkeypatch, owner_type):
    source = {"id": "revision", "generation_id": "root", "user_id": "owner", "user_type": owner_type}
    row = {**source, "version": 3, "prompt": "rover", "detail_level": 30,
           "endpoint": "llmToBricks", "created_at": "2026-09-30", "status": "completed", "generation_duration_seconds": 50}
    storage = SimpleNamespace(get_generation=AsyncMock(return_value=source),
                              get_generation_versions=AsyncMock(return_value=[row]))
    monkeypatch.setattr(history, "generation_storage", storage)
    result = asyncio.run(history.get_generations_by_image(
        history.GetGenerationsByImageRequest(generation_id="revision"),
        {"user_id": "owner", "authenticated": owner_type == "authenticated"}))
    assert result.generations[0].version == 3
    assert result.generations[0].generation_duration_seconds == 50
    storage.get_generation_versions.assert_awaited_once_with(
        generation_id="root", user_id="owner", user_type=owner_type)
    with pytest.raises(HTTPException) as error:
        asyncio.run(history.get_generations_by_image(
            history.GetGenerationsByImageRequest(generation_id="revision"),
            {"user_id": "other", "authenticated": owner_type == "authenticated"}))
    assert error.value.status_code == 404
    assert storage.get_generation_versions.await_count == 1


@pytest.mark.parametrize("module, function, edit_request", [
    (manual, "update_model", manual.UpdateModelRequest(generation_id="source", xyzrgb_content="0 0 0 255 0 0")),
    (image_edit, "prompt_edit_model", image_edit.PromptEditModelRequest(generation_id="source", edit_prompt="blue roof")),
    (llm, "llm_to_bricks", llm.LlmToBricksRequest(generation_id="source", prompt="blue roof")),
])
def test_all_edit_requests_pass_parent_and_actual_owner_id(monkeypatch, module, function, edit_request):
    storage = SimpleNamespace(create_generation=AsyncMock(return_value="edit"),
                              store_model_file=AsyncMock(), update_status=AsyncMock())
    monkeypatch.setattr(module, "generation_storage", storage)
    if module is llm:
        monkeypatch.setattr(module, "_background_tasks", set())
    monkeypatch.setattr(module, "handle_auth_and_tracking", lambda **_: {
        "user_email": "owner@example.com", "is_anonymous": False, "is_developer": True})
    parent = {"processed_image_url": "image", "detail_level": 30}
    lookup = "_load_edit_source" if module is llm else (
        "get_owned_generation_or_403" if module is image_edit else "get_generation_or_404")
    monkeypatch.setattr(module, lookup, AsyncMock(return_value=parent))
    def start(_id, coro):
        coro.close()
        return Mock()
    monkeypatch.setattr(module, "start_generation_task", start)
    response = asyncio.run(getattr(module, function)(edit_request, {"authenticated": True, "user_id": "owner"}))
    assert response.generation_id == "edit"
    assert storage.create_generation.await_args.kwargs["edit_generation_id"] == "source"
    assert storage.create_generation.await_args.kwargs["user_id"] == "owner"


@pytest.mark.parametrize("status_filter, table", [(None, "latest_generations"), (["processing"], "generations")])
def test_storage_selects_latest_models_but_each_active_job(status_filter, table):
    query = Mock()
    for method in ["select", "eq", "in_", "order", "range"]:
        getattr(query, method).return_value = query
    query.execute.return_value = SimpleNamespace(data=[{"id": "latest"}], count=1)
    storage = GenerationStorage.__new__(GenerationStorage)
    storage.client = SimpleNamespace(table=Mock(return_value=query))
    assert asyncio.run(storage.get_user_generations("owner", "authenticated", limit=3, offset=4, status_filter=status_filter)) == [{"id": "latest"}]
    assert asyncio.run(storage.count_user_generations("owner", "authenticated", status_filter=status_filter)) == 1
    assert all(call.args == (table,) for call in storage.client.table.call_args_list)
    query.range.assert_called_once_with(4, 6)
    query.eq.assert_any_call("user_id", "owner")
    query.eq.assert_any_call("user_type", "authenticated")


def test_history_storage_keeps_versions_beyond_postgrest_page_limit():
    query = Mock()
    for method in ["select", "eq", "order", "range"]:
        getattr(query, method).return_value = query
    query.execute.side_effect = [SimpleNamespace(data=[{"version": v} for v in range(501, 1, -1)]),
                                 SimpleNamespace(data=[{"version": 1}])]
    storage = GenerationStorage.__new__(GenerationStorage)
    storage.client = SimpleNamespace(table=Mock(return_value=query))
    rows = asyncio.run(storage.get_generation_versions("root", "owner", "anonymous"))
    assert [row["version"] for row in rows] == list(range(501, 0, -1))
    assert [call.args for call in query.range.call_args_list] == [(0, 499), (500, 999)]
    query.eq.assert_any_call("generation_id", "root")
    query.eq.assert_any_call("user_id", "owner")
    query.eq.assert_any_call("user_type", "anonymous")


def test_streaming_llm_edit_uses_the_same_parent_and_owner_contract(monkeypatch):
    storage = SimpleNamespace(create_generation=AsyncMock(return_value="stream-edit"))
    monkeypatch.setattr(llm, "generation_storage", storage)
    monkeypatch.setattr(llm, "_load_edit_source", AsyncMock())
    monkeypatch.setattr(llm, "handle_auth_and_tracking", lambda **_: {
        "is_anonymous": False, "is_developer": True, "user_email": "owner@example.com"})
    async def start():
        stream = await llm.llm_to_bricks_stream(
            llm.LlmToBricksRequest(generation_id="source", prompt="blue roof"),
            {"authenticated": True, "user_id": "owner"})
        event = await anext(stream)
        await stream.aclose()
        return event
    assert '"generation_id": "stream-edit"' in asyncio.run(start())
    assert storage.create_generation.await_args.kwargs["edit_generation_id"] == "source"
    assert storage.create_generation.await_args.kwargs["user_id"] == "owner"


def test_legacy_llm_request_name_is_only_an_input_alias():
    request = llm.LlmToBricksRequest(source_generation_id="old", prompt="blue roof")
    assert request.generation_id == "old"
    assert "source_generation_id" not in request.model_dump()


@pytest.mark.parametrize("owner,community,expected_model", [
    ("owner", False, "root"), ("other", True, None),
])
def test_generation_creation_persists_only_model_identity_and_inherits_name(owner, community, expected_model):
    query = Mock()
    query.insert.return_value = query
    storage = GenerationStorage.__new__(GenerationStorage)
    storage.client = SimpleNamespace(table=Mock(return_value=query))
    storage.get_generation = AsyncMock(return_value={
        "id": "old", "generation_id": "root", "user_id": owner, "user_type": "authenticated",
        "name": "Moon Rover", "status": "completed", "is_community": community,
    })
    id = asyncio.run(storage.create_generation("owner", "authenticated", "blue roof", 30, edit_generation_id="old"))
    payload = query.insert.call_args.args[0]
    assert payload["generation_id"] == (expected_model or id)
    assert payload["name"] == "Moon Rover"
    assert "source_generation_id" not in payload


@pytest.mark.parametrize("source", [None, {"id": "private", "user_id": "other", "user_type": "authenticated"}])
def test_generation_creation_rejects_missing_or_private_revision(source):
    storage = GenerationStorage.__new__(GenerationStorage)
    storage.client = Mock()
    storage.get_generation = AsyncMock(return_value=source)
    with pytest.raises(ValueError):
        asyncio.run(storage.create_generation("owner", "authenticated", "blue roof", 30, edit_generation_id="private"))
    storage.client.table.assert_not_called()


@pytest.mark.parametrize("previous", [None, {"id": "previous"}])
def test_cancelled_version_returns_computed_completed_fallback_without_parent_column(monkeypatch, previous):
    row = {"id": "cancelled", "generation_id": "root", "version": 4, "user_id": "owner",
           "user_type": "authenticated", "status": "cancelled"}
    storage = SimpleNamespace(get_generation=AsyncMock(return_value=row),
                              get_previous_completed_generation=AsyncMock(return_value=previous))
    monkeypatch.setattr(generation_endpoint, "generation_storage", storage)
    result = asyncio.run(generation_endpoint.get_generation(
        generation_endpoint.GetGenerationRequest(generation_id="cancelled"),
        {"user_id": "owner", "authenticated": True}))
    assert result.previous_completed_generation_id == (previous["id"] if previous else None)
    assert result.model_generation_id == "root" and result.version == 4
    assert "source_generation_id" not in result.model_dump()


def test_model_response_includes_saved_example_and_duration_without_private_usage(monkeypatch):
    store = SimpleNamespace(get_generation=AsyncMock(return_value={
        'id': 'g', 'status': 'completed', 'name': 'Fish', 'example_edit_prompt': 'Make the fins blue',
        'generation_duration_seconds': 90, 'tokens_used': 12000, 'ai_usage': {'private': True},
    }))
    monkeypatch.setattr(generation_endpoint, 'generation_storage', store)
    response = asyncio.run(generation_endpoint.get_generation(generation_endpoint.GetGenerationRequest(generation_id='g'), {}))
    assert response.example_edit_prompt == 'Make the fins blue'
    assert response.generation_duration_seconds == 90
    assert 'ai_usage' not in response.model_dump() and 'tokens_used' not in response.model_dump()
