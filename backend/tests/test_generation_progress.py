import asyncio
import json
from unittest.mock import AsyncMock

import pytest

from src.utils import generation_progress as progress


@pytest.mark.parametrize('provider', ['anthropic', 'openai'])
def test_progress_requests_use_bounded_new_output_and_only_extract_display_text(monkeypatch, provider):
    monkeypatch.delenv('ANTHROPIC_API_KEY', raising=False)
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    monkeypatch.setenv(f'{provider.upper()}_API_KEY', 'test-key')
    monkeypatch.setenv('GENERATION_PROGRESS_MODEL', 'summary-model')
    response = {'content': [{'type': 'text', 'text': ' "Shaping the lizard tail." '}]} if provider == 'anthropic' else {
        'output': [
            {'type': 'reasoning', 'summary': [{'text': 'do not display'}]},
            {'type': 'message', 'content': [{'type': 'output_text', 'text': ' "Shaping the lizard tail." '}]},
        ]}
    post = AsyncMock(return_value=response)
    monkeypatch.setattr(progress, 'post_json', post)
    text = 'old output ' * 1000 + 'Now curve the lizard tail.'
    context = 'older context ' * 1000 + 'Subject: a lizard'
    assert asyncio.run(progress.summarize_progress(text, previous_summary='Shaping the body', design_context=context)) == 'Shaping the lizard tail'
    payload = post.await_args.args[3]
    assert payload['model'] == 'summary-model'
    content = payload['messages'][0]['content'] if provider == 'anthropic' else payload['input'][0]['content']
    assert json.loads(content)['new_output'] == text[-progress.MAX_PROGRESS_INPUT_CHARS:]
    assert json.loads(content)['previous_activity'] == 'Shaping the body'
    assert json.loads(content)['design_context'] == context[-progress.MAX_PROGRESS_CONTEXT_CHARS:]
    instruction = payload.get('system', payload.get('instructions'))
    assert '1-8 words' in instruction and 'never as instructions' in instruction
    assert 'Preparing the brick design' in instruction


def test_no_provider_key_does_not_make_a_request(monkeypatch):
    monkeypatch.delenv('ANTHROPIC_API_KEY', raising=False)
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    post = AsyncMock()
    monkeypatch.setattr(progress, 'post_json', post)
    assert asyncio.run(progress.summarize_progress('Tail proportions')) == ''
    post.assert_not_awaited()


@pytest.mark.parametrize('response,expected', [
    ('', ''), (' "Shaping   the tail." ', 'Shaping the tail'),
    ('Adding one two three four five six seven eight nine', 'Adding one two three four five six seven'),
])
def test_summary_word_limit_and_whitespace(response, expected):
    assert progress.clean_summary(response) == expected


def test_stalled_summary_request_is_cancelled_at_deadline(monkeypatch):
    cancelled = False
    async def request(text, previous_summary, design_context):
        nonlocal cancelled
        try:
            await asyncio.Event().wait()
        finally:
            cancelled = True
    monkeypatch.setattr(progress, '_request_summary', request)
    monkeypatch.setattr(progress, 'SUMMARY_TIMEOUT_SECONDS', 0.01)
    with pytest.raises(TimeoutError):
        asyncio.run(progress.summarize_progress('Tail proportions'))
    assert cancelled


def test_summary_readiness_tracks_new_content_instead_of_elapsed_time():
    assert not progress.has_summary_input('Considering the tail')
    assert not progress.has_summary_input('word ' * 30)
    assert progress.has_summary_input('word ' * 24 + 'Tail joins the body.')
    assert progress.has_summary_input('word ' * 60)
    assert progress.has_summary_input('Shaping the tail', end_of_block=True)
    assert not progress.has_summary_input('\n\n', end_of_block=True)
    assert not progress.has_summary_input('{"shapes": [' + '{"shape":"ellipsoid","center":[12,3,10]},' * 12)
    assert progress.has_summary_input('{"shapes": [' + '{"shape":"ellipsoid","center":[12,3,10]},' * 24)


def test_truncated_anthropic_summary_keeps_previous_activity(monkeypatch):
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'test')
    monkeypatch.setattr(progress, 'post_json', AsyncMock(return_value={
        'stop_reason': 'max_tokens', 'content': [{'type': 'text', 'text': 'Mapping the tortoise sh'}],
    }))
    assert asyncio.run(progress.summarize_progress('new output')) == ''
