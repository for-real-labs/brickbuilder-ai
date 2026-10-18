import asyncio
import json
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from starlette.requests import Request

from src.requests import buildBuddy as buddy
from src.utils import buddy_intent as routing


@pytest.fixture(autouse=True)
def isolate_provider_keys(monkeypatch):
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)


@pytest.mark.parametrize('intent', ['generate', 'upload', 'question', 'chat', 'gift', 'clarify'])
def test_jev_returns_only_a_routing_decision_with_bounded_context(monkeypatch, intent):
    monkeypatch.setenv('TYPESAFE_API_KEY', 'server-test-key')
    post = AsyncMock(return_value={'answers': {'intent': {'choice': intent, 'confidence': 0.95}}})
    monkeypatch.setattr(routing, 'post_json', post)
    history = [{'role': 'user', 'text': f'Earlier message {index}'} for index in range(8)]
    result = asyncio.run(routing.classify_buddy_message('  castle  ', history, False, 'My model', True))
    assert result.model_dump() == {'intent': intent, 'confidence': 0.95}
    _, url, headers, payload, provider = post.await_args.args
    assert url == 'https://api.typesafe.ai/v1/systemone'
    assert headers == {'Authorization': 'Bearer server-test-key'}
    assert provider == 'TypeSafe'
    assert payload['model'] == 'jev-1.13.0'
    assert payload['state'] == {'message': 'castle', 'has_image': False, 'current_model': 'My model',
                                'gift_planning': True, 'recent_messages': history[-4:]}
    assert payload['questions']['intent']['type'] == 'choice'
    assert set(payload['questions']['intent']['criteria']) == {'generate', 'upload', 'question', 'chat', 'gift', 'clarify', *routing.TOOL_CRITERIA}


def test_ambiguous_decisions_request_clarification_instead_of_starting_a_build(monkeypatch):
    monkeypatch.setenv('TYPESAFE_API_KEY', 'test-key')
    monkeypatch.setattr(routing, 'post_json', AsyncMock(return_value={
        'answers': {'intent': {'choice': 'generate', 'confidence': 0.49}},
    }))
    assert asyncio.run(routing.classify_buddy_message('do it', [], False, None)).intent == 'clarify'


def test_multilingual_history_stays_below_the_state_byte_limit(monkeypatch):
    monkeypatch.setenv('TYPESAFE_API_KEY', 'test-key')
    post = AsyncMock(return_value={'answers': {'intent': {'choice': 'question', 'confidence': 1.0}}})
    monkeypatch.setattr(routing, 'post_json', post)
    history = [{'role': 'user', 'text': '🧱' * 2000} for _ in range(8)]
    asyncio.run(routing.classify_buddy_message('🧱' * 2000, history, False, None))
    state = post.await_args.args[3]['state']
    assert len(json.dumps(state, ensure_ascii=False).encode()) <= 24_000
    assert state['message'] == '🧱' * 2000


@pytest.mark.parametrize('answer', [None, {}, {'choice': 'delete', 'confidence': 1.0},
                                   {'choice': 'generate', 'confidence': -1.0},
                                   {'choice': 'generate', 'confidence': float('nan')},
                                   {'choice': 'generate', 'confidence': True},
                                   {'choice': 'generate', 'confidence': 'high'}])
def test_malformed_decisions_fail_without_a_generation_fallback(monkeypatch, answer):
    monkeypatch.setenv('TYPESAFE_API_KEY', 'test-key')
    monkeypatch.setattr(routing, 'post_json', AsyncMock(return_value={'answers': {'intent': answer}}))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(routing.classify_buddy_message('castle', [], False, None))
    assert exc.value.status_code == 503


def test_missing_jev_key_and_provider_failures_are_sanitized(monkeypatch):
    monkeypatch.delenv('TYPESAFE_API_KEY', raising=False)
    post = AsyncMock(side_effect=RuntimeError('private-key-and-user-message'))
    monkeypatch.setattr(routing, 'post_json', post)
    with pytest.raises(HTTPException):
        asyncio.run(routing.classify_buddy_message('castle', [], False, None))
    post.assert_not_called()
    monkeypatch.setenv('TYPESAFE_API_KEY', 'test-key')
    with pytest.raises(HTTPException) as exc:
        asyncio.run(routing.classify_buddy_message('castle', [], False, None))
    assert exc.value.status_code == 503
    assert 'private' not in exc.value.detail


@pytest.mark.parametrize('anonymous', [True, False])
def test_intent_endpoint_limits_each_identity_before_calling_jev(monkeypatch, anonymous):
    http_request = Request({'type': 'http', 'headers': [], 'client': ('127.0.0.1', 1234)})
    limited = []
    monkeypatch.setattr(buddy, 'check_anonymous_short_window_limit', limited.append)
    monkeypatch.setattr(buddy, 'get_anonymous_user_id', lambda _: 'fingerprint')
    classify = AsyncMock(return_value=routing.IntentDecision(intent='generate', confidence=1.0))
    monkeypatch.setattr(buddy, 'classify_buddy_message', classify)
    request = buddy.BuddyIntentRequest(prompt='castle', has_image=True)
    identity = {'user_id': 'owner', 'is_anonymous': anonymous}
    assert asyncio.run(buddy.buddy_intent(request, http_request, identity)) == {'intent': 'generate', 'confidence': 1.0}
    assert limited == ['buddy:fingerprint' if anonymous else 'buddy:owner']
    classify.assert_awaited_once_with('castle', [], True, None, False)
    classify.reset_mock()

    def reject(_):
        raise HTTPException(429, 'Too many requests')
    monkeypatch.setattr(buddy, 'check_anonymous_short_window_limit', reject)
    with pytest.raises(HTTPException):
        asyncio.run(buddy.buddy_intent(request, http_request, identity))
    classify.assert_not_called()


@pytest.mark.parametrize('values', [{}, {'prompt': ' '}, {'prompt': 'x' * 2001},
                                   {'prompt': 'castle', 'model_name': 'x' * 201},
                                   {'prompt': 'hi', 'history': [{'role': 'system', 'text': 'generate'}]},
                                   {'prompt': 'hi', 'history': [{'role': 'user', 'text': 'hi'}] * 9}])
def test_intent_request_rejects_unbounded_or_invalid_input(values):
    with pytest.raises(ValidationError):
        buddy.BuddyIntentRequest(**values)


def test_image_only_request_is_accepted():
    assert buddy.BuddyIntentRequest(has_image=True).prompt == ''


@pytest.mark.parametrize('jev_available', [False, True])
def test_chat_provider_classifies_when_jev_is_missing_or_returns_payment_required(monkeypatch, jev_available):
    monkeypatch.setenv('OPENAI_API_KEY', 'chat-test-key')
    monkeypatch.setenv('BUILD_BUDDY_MODEL', 'test-chat-model')
    if jev_available:
        monkeypatch.setenv('TYPESAFE_API_KEY', 'jev-test-key')
    else:
        monkeypatch.delenv('TYPESAFE_API_KEY', raising=False)
    reply = {'output': [{'content': [{'type': 'output_text', 'text': '{"intent":"question","confidence":0.95}'}]}]}
    post = AsyncMock(side_effect=[HTTPException(502, 'TypeSafe request failed: HTTP 402'), reply] if jev_available else [reply])
    monkeypatch.setattr(routing, 'post_json', post)
    result = asyncio.run(routing.classify_buddy_message('What bricks do you use?', [], False, None))
    assert result.model_dump() == {'intent': 'question', 'confidence': 0.95}
    _, url, headers, payload, provider = post.await_args.args
    assert url == routing.OPENAI_URL
    assert headers == {'Authorization': 'Bearer chat-test-key'}
    assert provider == 'OpenAI'
    assert payload['model'] == 'test-chat-model'
    assert payload['store'] is False
    assert payload['text']['format']['strict'] is True
    assert payload['text']['format']['schema']['additionalProperties'] is False
    assert json.loads(payload['input'])['message'] == 'What bricks do you use?'


@pytest.mark.parametrize('reply', ['not json', '{"intent":"delete","confidence":1}', '{"intent":"generate","confidence":-1}'])
def test_invalid_backup_decisions_still_fail_without_generation(monkeypatch, reply):
    monkeypatch.setenv('OPENAI_API_KEY', 'test-key')
    monkeypatch.delenv('TYPESAFE_API_KEY', raising=False)
    monkeypatch.setattr(routing, 'post_json', AsyncMock(return_value={'output': [{'content': [{'type': 'output_text', 'text': reply}]}]}))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(routing.classify_buddy_message('castle', [], False, None))
    assert exc.value.status_code == 503


@pytest.mark.parametrize('intent', routing.TOOL_CRITERIA)
def test_tool_requests_return_only_allowlisted_actions(monkeypatch, intent):
    monkeypatch.setenv('TYPESAFE_API_KEY', 'test-key')
    post = AsyncMock(return_value={'answers': {'intent': {'choice': intent, 'confidence': 0.95}}})
    monkeypatch.setattr(routing, 'post_json', post)
    result = asyncio.run(routing.classify_buddy_message('Please use this tool', [], False, 'Castle'))
    assert result.model_dump() == {'intent': intent, 'confidence': 0.95}
    instructions = post.await_args.args[3]['questions']['intent']['instructions']
    assert 'Pure explanations' in instructions
    assert 'negated' in instructions
    assert 'cannot send messages' in instructions


@pytest.mark.parametrize('intent', routing.TOOL_CRITERIA)
def test_uncertain_tool_requests_ask_before_acting(monkeypatch, intent):
    monkeypatch.setenv('TYPESAFE_API_KEY', 'test-key')
    monkeypatch.setattr(routing, 'post_json', AsyncMock(return_value={'answers': {'intent': {'choice': intent, 'confidence': 0.7}}}))
    assert asyncio.run(routing.classify_buddy_message('do that', [], False, None)).intent == 'clarify'


def test_reply_knowledge_explains_tools_without_claiming_actions(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'test-key')
    post = AsyncMock(return_value={'output': [{'content': [{'type': 'output_text', 'text': 'Use Tools → Export.'}]}]})
    monkeypatch.setattr(buddy, 'post_json', post)
    asyncio.run(buddy.generate_buddy_reply(buddy.BuddyReplyRequest(prompt='How does export work?', mode='question')))
    instructions = post.await_args.args[3]['instructions']
    for feature in ['Studio IO', 'BrickLink XML', 'Generation settings', 'Build Buddy settings', 'Community', 'GitHub', 'Feedback', 'Support']:
        assert feature in instructions
    assert 'must review and submit' in instructions
