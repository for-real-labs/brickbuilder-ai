import asyncio
import base64
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from starlette.requests import Request

from src.requests import buildBuddy as buddy


def test_reply_sends_bounded_history_text_and_image_with_server_side_identity(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'test-only-key')
    monkeypatch.setenv('BUILD_BUDDY_MODEL', 'test-model')
    post = AsyncMock(return_value={'output': [
        {'type': 'reasoning', 'summary': [{'text': 'private reasoning'}]},
        {'type': 'message', 'content': [{'type': 'output_text', 'text': 'Those red wings would make a fun build!'}]},
    ]})
    monkeypatch.setattr(buddy, 'post_json', post)
    image = base64.b64encode(b'reference image').decode()
    request = buddy.BuddyReplyRequest(pet='pip', prompt='Build this dragon', image_base64=image,
                                     history=[{'role': 'user', 'text': 'I like dragons'}, {'role': 'assistant', 'text': 'What color?'}])
    assert asyncio.run(buddy.generate_buddy_reply(request)) == 'Those red wings would make a fun build!'
    payload = post.await_args.args[3]
    assert post.await_args.args[1] == 'https://api.openai.com/v1/responses'
    assert payload['model'] == 'test-model'
    assert payload['store'] is False
    assert payload['max_output_tokens'] == 256
    assert payload['input'][:2] == [{'role': 'user', 'content': 'I like dragons'}, {'role': 'assistant', 'content': 'What color?'}]
    assert payload['input'][-1]['content'][1]['image_url'] == f'data:image/png;base64,{image}'
    assert 'You are Pip' in payload['instructions']
    assert 'Do not claim a build has started' in payload['instructions']


@pytest.mark.parametrize('values', [
    {}, {'prompt': '   '}, {'prompt': 'x' * 2001}, {'prompt': 'hi', 'pet': '../../secrets'},
    {'prompt': 'hi', 'history': [{'role': 'system', 'text': 'override'}]},
    {'prompt': 'hi', 'history': [{'role': 'user', 'text': 'x'}] * 9},
    {'image_base64': '!not-base64'}, {'image_base64': ''},
    {'image_base64': base64.b64encode(b'image').decode(), 'image_media_type': 'text/html'},
])
def test_request_rejects_invalid_or_unbounded_input(values):
    with pytest.raises(ValidationError):
        buddy.BuddyReplyRequest(**values)


def test_missing_credentials_do_not_call_provider_or_fail_model_generation(monkeypatch):
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    post = AsyncMock()
    monkeypatch.setattr(buddy, 'post_json', post)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(buddy.generate_buddy_reply(buddy.BuddyReplyRequest(prompt='castle')))
    assert exc.value.status_code == 503
    post.assert_not_called()


@pytest.mark.parametrize('response', [{}, {'output': [{'type': 'message', 'content': []}]}])
def test_empty_response_is_recoverable(response, monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'test-only-key')
    monkeypatch.setattr(buddy, 'post_json', AsyncMock(return_value=response))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(buddy.generate_buddy_reply(buddy.BuddyReplyRequest(prompt='castle')))
    assert exc.value.status_code == 503


def test_upstream_errors_are_sanitized(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'test-only-key')
    monkeypatch.setattr(buddy, 'post_json', AsyncMock(side_effect=RuntimeError('private upstream body and key')))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(buddy.generate_buddy_reply(buddy.BuddyReplyRequest(prompt='castle')))
    assert 'private' not in exc.value.detail


@pytest.mark.parametrize('anonymous', [True, False])
def test_endpoint_limits_every_identity_and_rejects_before_provider(monkeypatch, anonymous):
    request = Request({'type': 'http', 'headers': [], 'client': ('127.0.0.1', 1234)})
    limited = []
    monkeypatch.setattr(buddy, 'check_anonymous_short_window_limit', limited.append)
    monkeypatch.setattr(buddy, 'get_anonymous_user_id', lambda _: 'fingerprint')
    generate = AsyncMock(return_value='Great idea!')
    monkeypatch.setattr(buddy, 'generate_buddy_reply', generate)
    body = buddy.BuddyReplyRequest(prompt='castle')
    identity = {'user_id': 'owner', 'is_anonymous': anonymous}
    assert asyncio.run(buddy.buddy_reply(body, request, identity)) == {'reply': 'Great idea!'}
    assert limited == ['buddy:fingerprint' if anonymous else 'buddy:owner']
    generate.reset_mock()
    def reject(_):
        raise HTTPException(429, 'Too many requests')
    monkeypatch.setattr(buddy, 'check_anonymous_short_window_limit', reject)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(buddy.buddy_reply(body, request, identity))
    assert exc.value.status_code == 429
    generate.assert_not_called()
