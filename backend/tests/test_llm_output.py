import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from src.utils import llm_output as module


def test_recorder_saves_text_and_finishes_after_background_work(monkeypatch):
    write = AsyncMock()
    monkeypatch.setattr(module, 'write_output', write)

    async def generate(id, prompt, on_text):
        await on_text('Building ')
        await on_text('a castle')
        return None

    asyncio.run(module.run_with_output('job', generate, 'castle'))
    assert write.await_args.args == ('job', {'text': 'Building a castle', 'status': 'completed', 'error': None})


def test_failed_generation_is_recorded_and_storage_failure_does_not_fail_build(monkeypatch):
    write = AsyncMock()
    monkeypatch.setattr(module, 'write_output', write)
    asyncio.run(module.run_with_output('job', AsyncMock(return_value='Provider failed')))
    assert write.await_args.args[1]['status'] == 'failed'
    assert write.await_args.args[1]['error'] == 'Provider failed'
    write.side_effect = RuntimeError('storage unavailable')
    asyncio.run(module.run_with_output('job', AsyncMock(return_value=None)))


def test_stream_replays_saved_output_and_disconnect_leaves_producer_alone(monkeypatch):
    storage = SimpleNamespace(get_generation=AsyncMock(return_value={'status': 'processing', 'user_id': 'owner', 'user_type': 'anonymous'}))
    monkeypatch.setattr(module, 'generation_storage', storage)
    monkeypatch.setattr(module, 'read_output', AsyncMock(return_value={'text': 'Saved text', 'status': 'processing'}))
    monkeypatch.setattr(module, 'write_output', AsyncMock())

    async def run():
        started = asyncio.Event()
        release = asyncio.Event()
        async def generate(id, on_text):
            await on_text('Saved text')
            started.set()
            await release.wait()
        producer = asyncio.create_task(module.run_with_output('job', generate))
        await started.wait()
        stream = module.output_events('job', {'user_id': 'owner'})
        event = await anext(stream)
        assert json.loads(event[6:])['text'] == 'Saved text'
        await stream.aclose()
        assert not producer.done()
        release.set()
        await producer
    asyncio.run(run())


def test_stream_sends_terminal_status_and_final_text(monkeypatch):
    monkeypatch.setattr(module, 'generation_storage', SimpleNamespace(
        get_generation=AsyncMock(return_value={'status': 'completed', 'user_id': 'owner', 'user_type': 'anonymous'})))
    monkeypatch.setattr(module, 'read_output', AsyncMock(return_value={'text': 'Finished', 'status': 'completed'}))
    async def run():
        return [event async for event in module.output_events('job', {'user_id': 'owner'})]
    events = asyncio.run(run())
    assert len(events) == 1
    assert json.loads(events[0][6:])['status'] == 'completed'


def test_output_storage_uses_stable_path_and_replays_json(monkeypatch):
    bucket = Mock()
    bucket.download.return_value = b'{"text":"saved","status":"processing"}'
    storage = SimpleNamespace(bucket_name='generations', client=SimpleNamespace(storage=Mock()))
    storage.client.storage.from_.return_value = bucket
    monkeypatch.setattr(module, 'generation_storage', storage)
    asyncio.run(module.write_output('job', {'text': 'saved', 'status': 'processing'}))
    storage.client.storage.from_.assert_called_with('generation-output')
    assert bucket.upload.call_args.kwargs['path'] == 'job/llm-output.json'
    assert bucket.upload.call_args.kwargs['file_options']['upsert'] == 'true'
    assert asyncio.run(module.read_output('job'))['text'] == 'saved'


def test_recorder_bounds_output_size():
    recorder = module.OutputRecorder('job')
    asyncio.run(recorder.append('a' * (module.MAX_OUTPUT_CHARS + 10)))
    assert len(recorder.text) == module.MAX_OUTPUT_CHARS


def test_legacy_migration_copies_to_private_storage_before_removing_public_copy():
    from src.cli.migrate_generation_output import migrate
    class Missing(Exception):
        status = 404
    public, private = Mock(), Mock()
    public.download.return_value = b'{"text":"private"}'
    private.download.side_effect = Missing()
    query = Mock()
    query.select.return_value = query
    query.order.return_value = query
    query.range.return_value = query
    query.execute.return_value = SimpleNamespace(data=[{'id': 'job'}])
    storage = Mock()
    storage.get_bucket.return_value = SimpleNamespace(public=False)
    storage.from_.side_effect = lambda name: public if name == 'generations' else private
    client = SimpleNamespace(storage=storage, table=Mock(return_value=query))
    assert migrate(client) == 1
    public.remove.assert_not_called()
    assert migrate(client, apply=True) == 1
    private.upload.assert_called_once()
    public.remove.assert_called_once_with(['job/llm-output.json'])
    public.remove.reset_mock()
    private.upload.side_effect = RuntimeError('storage unavailable')
    with pytest.raises(RuntimeError):
        migrate(client, apply=True)
    public.remove.assert_not_called()
    storage.get_bucket.return_value.public = True
    with pytest.raises(RuntimeError):
        migrate(client, apply=True)
