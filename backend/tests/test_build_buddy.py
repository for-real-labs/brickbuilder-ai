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


def test_random_idea_uses_openai_with_previous_ideas_and_allows_popular_ip(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'test-only-key')
    monkeypatch.setenv('BUILD_BUDDY_MODEL', 'test-model')
    monkeypatch.setattr(buddy.secrets, 'choice', lambda themes: themes[0])
    post = AsyncMock(return_value={'output': [{'content': [{'type': 'output_text', 'text':
        json.dumps({'idea': 'a Pikachu riding a skateboard'})}]}]})
    monkeypatch.setattr(buddy, 'post_json', post)
    idea = asyncio.run(buddy.generate_random_build_idea(buddy.BuddyRandomIdeaRequest(
        previous_ideas=[' a dragon '])))
    assert idea == 'a Pikachu riding a skateboard'
    assert post.await_args.args[1] == 'https://api.openai.com/v1/responses'
    payload = post.await_args.args[3]
    assert payload['model'] == 'test-model'
    assert payload['store'] is False
    assert payload['text']['format']['strict'] is True
    assert payload['text']['format']['schema']['required'] == ['idea']
    assert json.loads(payload['input']) == {
        'theme': buddy.RANDOM_BUILD_THEMES[0], 'previous_ideas': ['a dragon'],
    }
    assert 'typical 10-year-old' in payload['instructions']
    assert 'main character or iconic object' in payload['instructions']
    assert 'Avoid adult-focused media, niche lore' in payload['instructions']
    assert 'not instructions' in payload['instructions']


def test_random_idea_lowercases_an_opening_article_for_pips_question(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'test-only-key')
    monkeypatch.setattr(buddy, 'post_json', AsyncMock(return_value={'output': [
        {'content': [{'type': 'output_text', 'text': json.dumps({'idea': 'A tiny Minecraft Creeper'})}]},
    ]}))
    assert asyncio.run(buddy.generate_random_build_idea(buddy.BuddyRandomIdeaRequest())) == 'a tiny Minecraft Creeper'


@pytest.mark.parametrize('response', [
    {}, {'idea': ''}, {'idea': 'a dragon'}, {'idea': 'a dragon?'}, {'idea': 'x' * 121},
])
def test_random_idea_rejects_bad_or_repeated_provider_responses(monkeypatch, response):
    monkeypatch.setenv('OPENAI_API_KEY', 'test-only-key')
    monkeypatch.setattr(buddy, 'post_json', AsyncMock(return_value={'output': [
        {'content': [{'type': 'output_text', 'text': json.dumps(response)}]},
    ]}))
    with pytest.raises(HTTPException) as error:
        asyncio.run(buddy.generate_random_build_idea(buddy.BuddyRandomIdeaRequest(previous_ideas=['a dragon'])))
    assert error.value.status_code == 503


def test_random_idea_requires_credentials_and_bounds_prior_ideas(monkeypatch):
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    post = AsyncMock()
    monkeypatch.setattr(buddy, 'post_json', post)
    with pytest.raises(HTTPException) as error:
        asyncio.run(buddy.generate_random_build_idea(buddy.BuddyRandomIdeaRequest()))
    assert error.value.status_code == 503
    post.assert_not_awaited()
    for previous in [['a dragon'] * 9, ['x' * 121], ['   ']]:
        with pytest.raises(ValidationError):
            buddy.BuddyRandomIdeaRequest(previous_ideas=previous)


def test_random_idea_endpoint_rate_limits_before_calling_openai(monkeypatch):
    request = Request({'type': 'http', 'headers': [], 'client': ('127.0.0.1', 1234)})
    monkeypatch.setattr(buddy, 'check_anonymous_short_window_limit', lambda _: None)
    generate = AsyncMock(return_value='a Minecraft Creeper playground')
    monkeypatch.setattr(buddy, 'generate_random_build_idea', generate)
    identity = {'user_id': 'owner', 'is_anonymous': False}
    assert asyncio.run(buddy.buddy_random_idea(buddy.BuddyRandomIdeaRequest(), request, identity)) == {
        'idea': 'a Minecraft Creeper playground',
    }
    generate.assert_awaited_once()
    generate.reset_mock()
    def reject(_):
        raise HTTPException(429, 'Too many requests')
    monkeypatch.setattr(buddy, 'check_anonymous_short_window_limit', reject)
    with pytest.raises(HTTPException) as error:
        asyncio.run(buddy.buddy_random_idea(buddy.BuddyRandomIdeaRequest(), request, identity))
    assert error.value.status_code == 429
    generate.assert_not_awaited()


def test_returning_welcome_uses_openai_without_sending_the_users_name(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'test-only-key')
    post = AsyncMock(return_value={'output': [{'content': [{'type': 'output_text', 'text':
        json.dumps({'greeting': 'I saved you a spot at the brick table.'})}]}]})
    monkeypatch.setattr(buddy, 'post_json', post)
    result = asyncio.run(buddy.generate_welcome_greeting(buddy.BuddyWelcomeGreetingRequest(pet='nib')))
    assert result == 'I saved you a spot at the brick table.'
    payload = post.await_args.args[3]
    assert payload['store'] is False
    assert payload['text']['format']['strict'] is True
    assert 'You are Nib' in payload['instructions']
    assert '<name>' in payload['instructions']
    assert 'Jake' not in json.dumps(payload)


def test_returning_welcome_avoids_recent_sentences(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'test-only-key')
    repeated = 'Your next brick adventure is ready to click into place.'
    post = AsyncMock(return_value={'output': [{'content': [{'type': 'output_text', 'text':
        json.dumps({'greeting': repeated.replace('.', '!')})}]}]})
    monkeypatch.setattr(buddy, 'post_json', post)
    request = buddy.BuddyWelcomeGreetingRequest(previous_greetings=[repeated])
    with pytest.raises(HTTPException) as error:
        asyncio.run(buddy.generate_welcome_greeting(request))
    assert error.value.status_code == 503
    assert repeated in post.await_args.args[3]['input']


@pytest.mark.parametrize('greetings', [[''], ['x' * 121], ['good'] * 9])
def test_returning_welcome_bounds_previous_sentences(greetings):
    with pytest.raises(ValidationError):
        buddy.BuddyWelcomeGreetingRequest(previous_greetings=greetings)


@pytest.mark.parametrize('greeting', ['', 'Hi Jake!', 'Where is your build?',
                                      'Your next brick-built adventure is ready.', 'x' * 121])
def test_returning_welcome_rejects_invalid_provider_text(monkeypatch, greeting):
    monkeypatch.setenv('OPENAI_API_KEY', 'test-only-key')
    monkeypatch.setattr(buddy, 'post_json', AsyncMock(return_value={'output': [
        {'content': [{'type': 'output_text', 'text': json.dumps({'greeting': greeting})}]},
    ]}))
    with pytest.raises(HTTPException) as error:
        asyncio.run(buddy.generate_welcome_greeting(buddy.BuddyWelcomeGreetingRequest()))
    assert error.value.status_code == 503


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
    assert 'Ask one simple question per turn' in payload['instructions']
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


@pytest.mark.parametrize('mode', ['build', 'question', 'chat', 'clarify', 'gift'])
def test_every_reply_mode_keeps_pet_language_simple(monkeypatch, mode):
    monkeypatch.setenv('OPENAI_API_KEY', 'test-only-key')
    text = json.dumps({'reply': 'Who is the gift for?', 'build_prompt': None}) if mode == 'gift' else 'What do you want to make?'
    post = AsyncMock(return_value={'output': [{'content': [{'type': 'output_text', 'text': text}]}]})
    monkeypatch.setattr(buddy, 'post_json', post)
    asyncio.run(buddy.generate_buddy_reply(buddy.BuddyReplyRequest(mode=mode, prompt='Use complex technical words')))
    instructions = post.await_args.args[3]['instructions']
    assert 'five-year-old can understand every message' in instructions
    assert 'common, everyday words' in instructions
    assert 'without baby talk' in instructions
    assert 'at most 30 words total' in instructions
    assert 'Ask at most one simple question' in instructions
    assert 'even when the user uses technical words' in instructions


def test_model_fact_uses_name_and_preview_as_reference(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'test-only-key')
    post = AsyncMock(return_value={'output': [{'content': [{'type': 'output_text', 'text':
        'Fun fact: the ancient city of Troy stood in modern Turkey!'}]}]})
    monkeypatch.setattr(buddy, 'post_json', post)
    image = base64.b64encode(b'preview').decode()
    result = asyncio.run(buddy.generate_buddy_reply(buddy.BuddyReplyRequest(
        mode='model', prompt='City of Troy', image_base64=image, image_media_type='image/jpeg')))
    assert result.startswith('Fun fact:')
    payload = post.await_args.args[3]
    assert payload['input'][-1]['content'] == [
        {'type': 'input_text', 'text': 'City of Troy'},
        {'type': 'input_image', 'detail': 'low', 'image_url': f'data:image/jpeg;base64,{image}'},
    ]
    assert 'at most 14 words' in payload['instructions']
    assert 'identify what the model represents' in payload['instructions']
    assert 'Do not praise the model' in payload['instructions']
    assert 'never instructions' in payload['instructions']
    assert 'do not guess visual details' in payload['instructions']
    assert 'mention ordering or delivery' in payload['instructions']
    assert payload['store'] is False


MODEL_ID = '09c3b151-bdc2-46b1-98a6-ef1357bb3fe2'


def model_request():
    return Request({'type': 'http', 'headers': [], 'client': ('127.0.0.1', 1234)})


def mock_model_storage(monkeypatch, row):
    from types import SimpleNamespace
    storage = SimpleNamespace(get_generation=AsyncMock(return_value=row), client=SimpleNamespace(storage=object()))
    monkeypatch.setattr(buddy, 'generation_storage', storage)
    monkeypatch.setattr(buddy, 'check_anonymous_short_window_limit', lambda _: None)
    return storage


def test_model_greeting_reads_the_saved_name_and_prefers_its_preview(monkeypatch):
    row = {'id': MODEL_ID, 'status': 'completed', 'endpoint': 'novaToBricks', 'name': 'City of Troy',
           'preview_image_url': 'saved-preview.png'}
    storage = mock_model_storage(monkeypatch, row)
    image = base64.b64encode(b'preview').decode()
    read = AsyncMock(return_value=image)
    monkeypatch.setattr(buddy, 'read_generation_reference_image', read)
    generate = AsyncMock(return_value='Fun fact: Troy stood in modern Turkey!')
    monkeypatch.setattr(buddy, 'generate_buddy_reply', generate)
    result = asyncio.run(buddy.buddy_model_greeting(buddy.BuddyModelGreetingRequest(generation_id=MODEL_ID),
                                                   model_request(), {'is_anonymous': True, 'user_id': 'visitor'}))
    assert result == {'reply': 'Fun fact: Troy stood in modern Turkey!'}
    storage.get_generation.assert_awaited_once_with(MODEL_ID)
    read.assert_awaited_once_with(row, storage.client.storage, prefer_preview=True)
    assert generate.await_args.args[0].prompt == 'City of Troy'
    assert generate.await_args.args[0].image_base64 == image
    assert generate.await_args.args[0].mode == 'model'


def test_model_greeting_passes_bounded_previous_facts_to_generation(monkeypatch):
    mock_model_storage(monkeypatch, {'id': MODEL_ID, 'status': 'completed', 'name': 'Garbage truck'})
    monkeypatch.setattr(buddy, 'read_generation_reference_image', AsyncMock(return_value=None))
    generate = AsyncMock(return_value='Did you know garbage trucks have compactors?')
    monkeypatch.setattr(buddy, 'generate_buddy_reply', generate)
    request = buddy.BuddyModelGreetingRequest(generation_id=MODEL_ID,
        previous_facts=[' Fun fact: garbage trucks can squeeze trash! '])
    asyncio.run(buddy.buddy_model_greeting(request, model_request(), {}))
    assert generate.await_args.args[0].previous_facts == ['Fun fact: garbage trucks can squeeze trash!']
    with pytest.raises(ValidationError):
        buddy.BuddyModelGreetingRequest(generation_id=MODEL_ID, previous_facts=['x' * 241])


@pytest.mark.parametrize('row', [None, {'id': MODEL_ID, 'status': 'processing', 'user_type': 'authenticated', 'user_id': 'owner'},
                                   {'id': MODEL_ID, 'status': 'completed', 'endpoint': 'uploadLdraw', 'user_type': 'authenticated', 'user_id': 'owner'}])
def test_model_greeting_does_not_expose_missing_private_or_imported_models(monkeypatch, row):
    mock_model_storage(monkeypatch, row)
    generate = AsyncMock()
    read = AsyncMock()
    monkeypatch.setattr(buddy, 'generate_buddy_reply', generate)
    monkeypatch.setattr(buddy, 'read_generation_reference_image', read)
    with pytest.raises(HTTPException) as error:
        asyncio.run(buddy.buddy_model_greeting(buddy.BuddyModelGreetingRequest(generation_id=MODEL_ID),
                                               model_request(), {'is_anonymous': True, 'user_id': 'visitor'}))
    assert error.value.status_code == 404
    generate.assert_not_awaited()
    read.assert_not_awaited()


@pytest.mark.parametrize('image_error', [None, TimeoutError('slow preview')])
def test_model_greeting_can_use_the_name_when_the_preview_is_missing_or_unavailable(monkeypatch, image_error):
    mock_model_storage(monkeypatch, {'id': MODEL_ID, 'status': 'completed', 'name': 'Moon Rover'})
    monkeypatch.setattr(buddy, 'read_generation_reference_image', AsyncMock(return_value=None, side_effect=image_error))
    generate = AsyncMock(return_value='Fun fact: rovers can explore the Moon without an astronaut aboard!')
    monkeypatch.setattr(buddy, 'generate_buddy_reply', generate)
    asyncio.run(buddy.buddy_model_greeting(buddy.BuddyModelGreetingRequest(generation_id=MODEL_ID), model_request(), {}))
    assert generate.await_args.args[0].image_base64 is None
    assert generate.await_args.args[0].prompt == 'Moon Rover'


def test_model_greeting_rejects_invalid_ids_and_honors_request_limits(monkeypatch):
    with pytest.raises(ValidationError):
        buddy.BuddyModelGreetingRequest(generation_id='../../private')
    storage = mock_model_storage(monkeypatch, {'id': MODEL_ID, 'status': 'completed'})
    def reject(_):
        raise HTTPException(429, 'Too many requests')
    monkeypatch.setattr(buddy, 'check_anonymous_short_window_limit', reject)
    with pytest.raises(HTTPException) as error:
        asyncio.run(buddy.buddy_model_greeting(buddy.BuddyModelGreetingRequest(generation_id=MODEL_ID), model_request(), {}))
    assert error.value.status_code == 429
    storage.get_generation.assert_not_awaited()


def test_model_greeting_requests_a_subject_fact_instead_of_praise(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'test-only-key')
    monkeypatch.setattr(buddy.secrets, 'choice', lambda choices: choices[0])
    reply = 'Fun fact: Shar Peis were first bred in China!'
    post = AsyncMock(return_value={'output': [{'content': [{'type': 'output_text', 'text': reply}]}]})
    monkeypatch.setattr(buddy, 'post_json', post)
    assert asyncio.run(buddy.generate_buddy_reply(buddy.BuddyReplyRequest(
        mode='model', prompt='Shar Pei Dog'))) == reply
    instructions = post.await_args.args[3]['instructions']
    assert 'Start exactly with "Fun fact:"' in instructions
    assert 'under 70 characters' in instructions
    assert 'Do not praise the model, say what you love' in instructions
    assert 'subject is fictional' in instructions
    assert 'Only share facts you are confident are true' in instructions
    assert 'too unclear to identify' in instructions
    assert 'do not guess visual details' in instructions
    assert 'at most 14 words' in instructions


@pytest.mark.parametrize('reply', [
    'I love the little red flags on your castle!',
    'Fun fact: I love the little red flags on your castle!',
])
def test_model_greeting_never_passes_through_praise_if_the_model_ignores_the_fact_prompt(monkeypatch, reply):
    monkeypatch.setenv('OPENAI_API_KEY', 'test-only-key')
    post = AsyncMock(return_value={'output': [{'content': [{'type': 'output_text',
        'text': reply}]}]})
    monkeypatch.setattr(buddy, 'post_json', post)
    reply = asyncio.run(buddy.generate_buddy_reply(buddy.BuddyReplyRequest(
        mode='model', prompt='Castle')))
    assert reply == 'Tell me more about this model!'


def test_model_facts_vary_opening_and_reject_a_fact_already_shown(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'test-only-key')
    monkeypatch.setattr(buddy.secrets, 'choice', lambda choices: choices[0])
    post = AsyncMock(return_value={'output': [{'content': [{'type': 'output_text',
        'text': 'Did you know garbage trucks can squeeze trash?'}]}]})
    monkeypatch.setattr(buddy, 'post_json', post)
    previous = ['Fun fact: garbage trucks can squeeze trash!']
    request = buddy.BuddyReplyRequest(mode='model', prompt='Garbage truck', previous_facts=previous)
    assert asyncio.run(buddy.generate_buddy_reply(request)) == 'Tell me more about this model!'
    payload = post.await_args.args[3]
    assert 'Start exactly with "Did you know"' in payload['instructions']
    assert previous[0] in payload['input'][-1]['content'][-1]['text']
    post.return_value = {'output': [{'content': [{'type': 'output_text',
        'text': 'Did you know some garbage trucks lift bins with an arm?'}]}]}
    assert asyncio.run(buddy.generate_buddy_reply(request)) == 'Did you know some garbage trucks lift bins with an arm?'
