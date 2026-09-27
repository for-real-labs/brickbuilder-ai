import asyncio
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware

from src import api


AUTH = {"user_id": "user"}


@pytest.mark.parametrize(
    "origin",
    [
        "https://brickbuilderai-git-jj-github-agent-workflow-jjohnson3700team.vercel.app",
        "https://brickbuilderai-git-staging-jjohnson3700team.vercel.app",
    ],
)
def test_vercel_deployments_are_allowed_by_cors(origin):
    middleware = CORSMiddleware(
        app=api.app,
        allow_origins=api.ALLOWED_ORIGINS,
        allow_origin_regex=api.ALLOWED_ORIGIN_REGEX,
    )
    assert middleware.is_allowed_origin(origin)


@pytest.mark.parametrize(
    "origin",
    [
        "http://brickbuilderai-git-staging-jjohnson3700team.vercel.app",
        "https://brickbuilderai-git-staging-anotherteam.vercel.app",
        "https://unrelated-jjohnson3700team.vercel.app",
    ],
)
def test_untrusted_vercel_origins_are_not_allowed_by_cors(origin):
    middleware = CORSMiddleware(
        app=api.app,
        allow_origins=api.ALLOWED_ORIGINS,
        allow_origin_regex=api.ALLOWED_ORIGIN_REGEX,
    )
    assert not middleware.is_allowed_origin(origin)


@pytest.mark.parametrize(
    ("endpoint_name", "handler_name", "call_args", "forwarded_args"),
    [
        ("glbToBricks_endpoint", "glb_to_bricks", ("file", "trimesh", 40, AUTH), ("file", "trimesh", 40, AUTH)),
        ("ldr_to_mpd_endpoint", "ldr_to_mpd", ("request", AUTH), ("request", AUTH)),
        ("part_to_mpd_endpoint", "part_to_mpd", ("request", AUTH), ("request", AUTH)),
        ("ldr_to_brickowl_endpoint", "ldr_to_brickowl", ("request", AUTH), ("request", AUTH)),
        ("estimate_price_endpoint", "estimate_price", ("request", AUTH), ("request", AUTH)),
        ("get_price_endpoint", "get_price", ("request", AUTH), ("request", AUTH)),
        ("resize_model_endpoint", "resize_model", ("request", AUTH), ("request", AUTH)),
        ("prompt_edit_model_endpoint", "prompt_edit_model", ("request", AUTH, None), ("request", AUTH)),
        ("llm_render_endpoint", "llm_render", ("request", AUTH), ("request", AUTH)),
        ("llm_to_bricks_endpoint", "llm_to_bricks", ("request", AUTH), ("request", AUTH)),
        ("create_checkout_session_endpoint", "create_checkout_session", ("request", AUTH), ("request", AUTH)),
        ("get_user_generations_endpoint", "get_user_generations", ("body", "http-request", AUTH), ("body", AUTH, "http-request")),
        ("get_generations_by_image_endpoint", "get_generations_by_image", ("body", AUTH), ("body", AUTH)),
        ("get_community_generations_endpoint", "get_community_generations", ("body", AUTH), ("body", AUTH)),
        ("get_generation_like_status_endpoint", "get_generation_like_status", ("request", AUTH), ("request", AUTH)),
        ("update_model_endpoint", "update_model", ("request", AUTH), ("request", AUTH)),
        ("update_ldr_and_parts_list_endpoint", "update_ldr_and_parts_list", ("request", AUTH), ("request", AUTH)),
        ("toggle_is_community_endpoint", "toggle_is_community", ("request", AUTH), ("request", AUTH)),
        ("toggle_generation_like_endpoint", "toggle_generation_like", ("request", AUTH), ("request", AUTH)),
        ("claim_generation_endpoint", "claim_generation", ("request", AUTH), ("request", AUTH)),
        ("update_generation_name_endpoint", "update_generation_name", ("request", AUTH), ("request", AUTH)),
        ("update_image_preview_endpoint", "update_image_preview", ("request", AUTH), ("request", AUTH)),
        ("update_username_endpoint", "update_username", ("request", AUTH), ("request", AUTH)),
    ],
)
def test_api_endpoints_delegate_to_request_handlers(monkeypatch, endpoint_name, handler_name, call_args, forwarded_args):
    handler = AsyncMock(return_value={"ok": True})
    monkeypatch.setattr(api, handler_name, handler)
    result = asyncio.run(getattr(api, endpoint_name)(*call_args))
    assert result == {"ok": True}
    handler.assert_awaited_once_with(*forwarded_args)


def test_generation_endpoints_delegate(monkeypatch):
    handler = AsyncMock(return_value={"status": "completed"})
    monkeypatch.setattr(api, "get_generation", handler)
    request = object()
    assert asyncio.run(api.get_generation_endpoint(request)) == {"status": "completed"}
    handler.assert_awaited_once_with(request)

    handler.reset_mock()
    asyncio.run(api.get_generation_by_id_endpoint("generation-1"))
    assert handler.await_args.args[0].generation_id == "generation-1"


def test_image_and_text_endpoints_choose_streaming_handler(monkeypatch):
    for endpoint, normal_name, stream_name in [
        (api.imageToBricks_endpoint, "image_to_bricks", "image_to_bricks_stream"),
        (api.textToBricks_endpoint, "text_to_bricks", "text_to_bricks_stream"),
    ]:
        normal = AsyncMock(return_value="normal")
        stream = AsyncMock(return_value="stream")
        monkeypatch.setattr(api, normal_name, normal)
        monkeypatch.setattr(api, stream_name, stream)
        request = type("Request", (), {"stream": False})()
        assert asyncio.run(endpoint(request, AUTH, None)) == "normal"
        request.stream = True
        assert asyncio.run(endpoint(request, AUTH, None)) == "stream"


def test_llm_render_stream_endpoint_wraps_handler(monkeypatch):
    async def events():
        yield 'data: {"type":"thinking","delta":"Building"}\n\n'

    monkeypatch.setattr(api, "llm_render_stream", lambda request, auth: events())
    response = asyncio.run(api.llm_render_stream_endpoint("request", AUTH))
    assert isinstance(response, StreamingResponse)
    assert response.media_type == "text/event-stream"


def test_llm_to_bricks_stream_endpoint_wraps_handler(monkeypatch):
    expected_events = [
        'data: {"type":"thinking","delta":"Planning"}\n\n',
        'data: {"type":"result","data":{"generation_id":"generation-1"}}\n\n',
    ]

    async def events():
        for event in expected_events:
            yield event

    handler = AsyncMock(return_value=events())
    monkeypatch.setattr(api, "llm_to_bricks_stream", handler)

    async def consume_response():
        response = await api.llm_to_bricks_stream_endpoint("request", AUTH)
        assert isinstance(response, StreamingResponse)
        assert response.media_type == "text/event-stream"
        return [event async for event in response.body_iterator]

    assert asyncio.run(consume_response()) == expected_events
    handler.assert_awaited_once_with("request", AUTH)


def test_unprotected_one_argument_endpoints(monkeypatch):
    email_handler = AsyncMock(return_value="sent")
    webhook_handler = AsyncMock(return_value="accepted")
    monkeypatch.setattr(api, "send_waitlist_email", email_handler)
    monkeypatch.setattr(api, "stripe_webhook", webhook_handler)
    assert asyncio.run(api.send_waitlist_email_endpoint("request")) == "sent"
    assert asyncio.run(api.stripe_webhook_endpoint("request")) == "accepted"
    webhook_handler.assert_awaited_once_with("request", {})


def test_health_and_fal_key_dependency(monkeypatch):
    monkeypatch.setattr(api, "track_api_call", lambda **_kwargs: None)
    assert asyncio.run(api.health_check()) == {"message": "brickai API is running"}
    monkeypatch.setattr(api, "FAL_KEY", None)
    with pytest.raises(HTTPException) as exc_info:
        api.require_fal_key()
    assert exc_info.value.status_code == 503
    monkeypatch.setattr(api, "FAL_KEY", "configured")
    assert api.require_fal_key() is None


def test_generation_output_endpoint_validates_job_before_streaming(monkeypatch):
    from types import SimpleNamespace
    from uuid import UUID

    id = UUID('7c1326b2-890a-4fb8-9750-d3aa15cdc8e4')
    storage = SimpleNamespace(get_generation=AsyncMock(return_value={'status': 'processing'}))
    monkeypatch.setattr(api, 'generation_storage', storage)
    async def events(generation_id):
        assert generation_id == str(id)
        yield 'data: {"type":"output","text":"Build","status":"processing"}\n\n'
    monkeypatch.setattr(api, 'output_events', events)
    async def run():
        response = await api.generation_output_endpoint(id)
        assert response.headers['x-accel-buffering'] == 'no'
        return [event async for event in response.body_iterator]
    assert len(asyncio.run(run())) == 1
    storage.get_generation.return_value = None
    with pytest.raises(HTTPException) as error:
        asyncio.run(api.generation_output_endpoint(id))
    assert error.value.status_code == 404
