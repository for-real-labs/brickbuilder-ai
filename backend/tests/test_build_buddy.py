import asyncio
import base64
import json
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


@pytest.mark.parametrize('build_prompt', [None, 'A LEGO garden with a purple bench for Mum'])
def test_gift_planning_uses_questions_history_and_structured_build_handoff(monkeypatch, build_prompt):
    monkeypatch.setenv('OPENAI_API_KEY', 'test-only-key')
    reply = 'Who is the gift for, and what do they love?' if build_prompt is None else 'A purple garden bench would be lovely!'
    post = AsyncMock(return_value={'output': [{'content': [{'type': 'output_text', 'text': json.dumps({
        'reply': reply, 'build_prompt': build_prompt,
    })}]}]})
    monkeypatch.setattr(buddy, 'post_json', post)
    history = [{'role': 'user', 'text': 'For Mum'}, {'role': 'assistant', 'text': 'What does she love?'}]
    result = asyncio.run(buddy.generate_buddy_reply(buddy.BuddyReplyRequest(mode='gift', prompt='Gardening', history=history)))
    assert result == {'reply': reply, 'build_prompt': build_prompt}
    payload = post.await_args.args[3]
    assert 'Ask one or two focused questions per turn' in payload['instructions']
    assert 'Planning does not generate a model' in payload['instructions']
    assert 'independently submits' not in payload['instructions']
    assert payload['input'][0] == {'role': 'user', 'content': 'For Mum'}
    assert payload['input'][-1]['content'][0]['text'] == 'Gardening'
    assert payload['text']['format']['strict'] is True
    assert payload['text']['format']['schema']['required'] == ['reply', 'build_prompt']
    assert payload['store'] is False


@pytest.mark.parametrize('reply', ['not json', 'null', '[]', '{"reply": ""}', '{"reply": 42}'])
def test_gift_planning_rejects_malformed_provider_output(monkeypatch, reply):
    monkeypatch.setenv('OPENAI_API_KEY', 'test-only-key')
    monkeypatch.setattr(buddy, 'post_json', AsyncMock(return_value={'output': [{'content': [{'type': 'output_text', 'text': reply}]}]}))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(buddy.generate_buddy_reply(buddy.BuddyReplyRequest(mode='gift', prompt='Gift idea?')))
    assert exc.value.status_code == 503


def test_gift_history_is_bounded_and_mode_is_validated():
    history = [{'role': 'user', 'text': 'answer'}] * 16
    assert len(buddy.BuddyReplyRequest(mode='gift', prompt='Gift', history=history).history) == 16
    with pytest.raises(ValidationError):
        buddy.BuddyReplyRequest(mode='gift', prompt='Gift', history=history + history)
    with pytest.raises(ValidationError):
        buddy.BuddyReplyRequest(mode='untrusted', prompt='Gift')


def test_endpoint_returns_gift_prompt_with_reply(monkeypatch):
    result = {'reply': 'A purple garden bench!', 'build_prompt': 'A LEGO garden with a purple bench'}
    monkeypatch.setattr(buddy, 'check_anonymous_short_window_limit', lambda _: None)
    monkeypatch.setattr(buddy, 'generate_buddy_reply', AsyncMock(return_value=result))
    request = Request({'type': 'http', 'headers': [], 'client': ('127.0.0.1', 1234)})
    assert asyncio.run(buddy.buddy_reply(buddy.BuddyReplyRequest(mode='gift', prompt='Gift'), request,
                                       {'user_id': 'owner', 'is_anonymous': False})) == result


@pytest.mark.parametrize('mode', ['question', 'chat', 'clarify'])
def test_conversational_modes_answer_without_assuming_generation(monkeypatch, mode):
    monkeypatch.setenv('OPENAI_API_KEY', 'test-only-key')
    post = AsyncMock(return_value={'output': [{'content': [{'type': 'output_text', 'text': 'What would you like to build in LEGO?'}]}]})
    monkeypatch.setattr(buddy, 'post_json', post)
    asyncio.run(buddy.generate_buddy_reply(buddy.BuddyReplyRequest(mode=mode, prompt='What do you mean?')))
    instructions = post.await_args.args[3]['instructions']
    assert 'without treating them as build requests' in instructions
    assert 'independently submits' not in instructions
    if mode == 'clarify':
        assert 'Ask one short clarifying question' in instructions
        assert 'Do not invent a build subject' in instructions
