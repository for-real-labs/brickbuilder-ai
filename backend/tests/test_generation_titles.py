import asyncio
import base64
import io
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from PIL import Image

from src.utils import generation_titles as titles
from src.utils import generation_storage as storage_module
from src.utils.generation_storage import GenerationStorage
from src.requests import updateGenerationName as rename
from fastapi import HTTPException


def test_fallback_titles_are_short_and_do_not_reuse_instruction_prefixes():
    assert titles.fallback_title('Please create me a dachshund in sunglasses. Use 300 bricks.') == 'Dachshund in sunglasses'
    assert titles.fallback_title('Image reference') == 'Custom Brick Model'
    assert titles.fallback_title(None) == 'Custom Brick Model'
    assert len(titles.fallback_title('long ' * 50).split()) <= 8
    assert len(titles.clean_title('abcdefghij ' * 20)) <= 80
    assert titles.clean_title('  "Moon   Rover"\n ') == 'Moon Rover'


@pytest.mark.parametrize('response', ['', '  "Sunny Dachshund"  '])
def test_title_generation_normalizes_provider_output_or_falls_back(monkeypatch, response):
    monkeypatch.setattr(titles, '_request_title', AsyncMock(return_value=response))
    assert asyncio.run(titles.generate_title({'prompt': 'a dachshund in sunglasses'}, None)) == (response.strip(' "') or 'Dachshund in sunglasses')


def test_provider_failure_and_timeout_do_not_fail_a_build(monkeypatch):
    monkeypatch.setattr(titles, '_request_title', AsyncMock(side_effect=TimeoutError()))
    assert asyncio.run(titles.generate_title({'prompt': 'a red rocket'}, None)) == 'Red rocket'


@pytest.mark.parametrize('provider', ['anthropic', 'openai'])
def test_title_request_uses_reference_data_and_extracts_only_text(monkeypatch, provider):
    monkeypatch.delenv('ANTHROPIC_API_KEY', raising=False)
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    monkeypatch.setenv(f'{provider.upper()}_API_KEY', 'test-key')
    response = {'content': [{'type': 'text', 'text': 'Sunny Dachshund'}]} if provider == 'anthropic' else {
        'output': [{'type': 'reasoning', 'summary': []}, {'type': 'message', 'content': [{'type': 'output_text', 'text': 'Sunny Dachshund'}]}]}
    post = AsyncMock(return_value=response)
    monkeypatch.setattr(titles, 'post_json', post)
    assert asyncio.run(titles.generate_title({'id': 'g', 'prompt': 'a dachshund in sunglasses'}, None)) == 'Sunny Dachshund'
    payload = post.await_args.args[3]
    assert 'reference' in payload.get('system', payload.get('instructions', ''))
    assert post.await_args.args[1] in {titles.ANTHROPIC_URL, titles.OPENAI_URL}


@pytest.mark.parametrize('url', [
    'https://example.com/secret.png',
    'https://db.example/storage/v1/object/public/generations/generations/other/image.png',
    'https://db.example/storage/v1/object/public/generations/generations/g/%2e%2e/secret.png',
])
def test_reference_image_never_fetches_arbitrary_urls_or_other_models(url):
    client = Mock()
    assert asyncio.run(titles._reference_image({'id': 'g', 'processed_image_url': url}, client)) is None
    client.from_.assert_not_called()


def test_reference_image_reads_only_the_models_storage_path_and_resizes_it():
    output = io.BytesIO()
    Image.new('RGB', (1024, 800)).save(output, 'PNG')
    bucket = SimpleNamespace(download=Mock(return_value=output.getvalue()))
    client = SimpleNamespace(from_=Mock(return_value=bucket))
    image = asyncio.run(titles._reference_image({'id': 'g', 'original_image_url':
        'https://db.example/storage/v1/object/public/generations/generations/g/original.png'}, client))
    client.from_.assert_called_once_with('generations')
    bucket.download.assert_called_once_with('generations/g/original.png')
    with Image.open(io.BytesIO(base64.b64decode(image))) as resized:
        assert resized.size == (512, 400)


class Query:
    def __init__(self, client):
        self.client = client
        self.filters = []
        self.values = None
    def select(self, fields): return self
    def eq(self, key, value): self.filters.append(('eq', key, value)); return self
    def neq(self, key, value): self.filters.append(('neq', key, value)); return self
    def is_(self, key, value): self.filters.append(('is', key, value)); return self
    def update(self, values): self.values = values; return self
    def insert(self, values): self.values = values; return self
    def execute(self):
        if self.values:
            self.client.writes.append((self.values, self.filters))
        return SimpleNamespace(data=[self.client.row])


def make_storage(row):
    client = SimpleNamespace(row=row, writes=[], storage=Mock())
    client.table = lambda _: Query(client)
    storage = GenerationStorage.__new__(GenerationStorage)
    storage.client = client
    storage.get_generation = AsyncMock(return_value=row)
    return storage


def test_completion_saves_name_before_publishing_and_guards_concurrent_renames(monkeypatch):
    storage = make_storage({'id': 'g', 'prompt': 'a dog', 'name': None, 'status': 'processing'})
    generate = AsyncMock(return_value='Sunny Dachshund')
    monkeypatch.setattr(storage_module, 'generate_title', generate)
    asyncio.run(storage.update_status('g', 'completed'))
    assert storage.client.writes[0] == ({'name': 'Sunny Dachshund'}, [('eq', 'id', 'g'), ('is', 'name', 'null'), ('neq', 'status', 'cancelled')])
    assert storage.client.writes[1][0]['status'] == 'completed'
    generate.assert_awaited_once()


@pytest.mark.parametrize('row', [None, {'name': 'My Custom Name'}, {'name': None, 'status': 'cancelled'}])
def test_existing_names_and_cancelled_builds_are_never_renamed(monkeypatch, row):
    storage = make_storage(row)
    generate = AsyncMock()
    monkeypatch.setattr(storage_module, 'generate_title', generate)
    asyncio.run(storage.ensure_generation_name('g'))
    generate.assert_not_awaited()
    assert storage.client.writes == []


def test_naming_storage_failure_does_not_block_completion(monkeypatch):
    storage = make_storage({'id': 'g', 'name': None})
    monkeypatch.setattr(storage_module, 'generate_title', AsyncMock(side_effect=RuntimeError()))
    asyncio.run(storage.update_status('g', 'completed'))
    assert storage.client.writes[0][0]['status'] == 'completed'


def test_derived_generation_inherits_saved_name():
    storage = make_storage({'id': 'source', 'generation_id': 'root', 'name': 'My Custom Name', 'user_id': 'user', 'user_type': 'authenticated'})
    asyncio.run(storage.create_generation('user', 'authenticated', 'Resize model', 40, edit_generation_id='source'))
    assert storage.client.writes[0][0]['name'] == 'My Custom Name'
    assert storage.client.writes[0][0]['generation_id'] == 'root'
    assert 'source_generation_id' not in storage.client.writes[0][0]


@pytest.mark.parametrize('auth,row,status', [
    ({'authenticated': False, 'is_anonymous': True}, {'user_id': 'owner', 'user_type': 'authenticated'}, 401),
    ({'authenticated': True, 'user_id': 'other'}, {'user_id': 'owner', 'user_type': 'authenticated', 'is_community': True}, 403),
    ({'authenticated': True, 'user_id': 'owner'}, {'user_id': 'owner', 'user_type': 'anonymous'}, 403),
])
def test_rename_rejects_visitors_and_nonowners_even_for_community_models(monkeypatch, auth, row, status):
    storage = make_storage(row)
    monkeypatch.setattr(rename, 'generation_storage', storage)
    monkeypatch.setattr(rename, 'handle_auth_and_tracking', lambda **_: {'user_email': 'test'})
    with pytest.raises(HTTPException) as error:
        asyncio.run(rename.update_generation_name(rename.UpdateGenerationNameRequest(generation_id='g', name='New Name'), auth))
    assert error.value.status_code == status
    assert storage.client.writes == []


def test_owner_rename_persists_trimmed_name_with_owner_filters(monkeypatch):
    storage = make_storage({'id': 'g', 'user_id': 'owner', 'user_type': 'authenticated'})
    monkeypatch.setattr(rename, 'generation_storage', storage)
    monkeypatch.setattr(rename, 'handle_auth_and_tracking', lambda **_: {'user_email': 'test'})
    result = asyncio.run(rename.update_generation_name(rename.UpdateGenerationNameRequest(generation_id='g', name='  New Name  '), {'authenticated': True, 'user_id': 'owner'}))
    assert result.name == 'New Name'
    assert storage.client.writes == [({'name': 'New Name'}, [('eq', 'id', 'g'), ('eq', 'user_id', 'owner'), ('eq', 'user_type', 'authenticated')])]
