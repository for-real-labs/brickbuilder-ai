import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
import pytest
import httpx

from src.utils import llm_output as module


@pytest.fixture(autouse=True)
def mock_progress_provider(monkeypatch):
    monkeypatch.setattr(module, 'summarize_progress', AsyncMock(return_value=''))


def test_recorder_saves_text_and_finishes_after_background_work(monkeypatch):
    write = AsyncMock()
    monkeypatch.setattr(module, 'write_output', write)

    async def generate(id, prompt, on_text):
        await on_text('Building ')
        await on_text('a castle')
        return None

    asyncio.run(module.run_with_output('job', generate, 'castle'))
    assert write.await_args.args == ('job', {'text': 'Building a castle', 'summary': '', 'status': 'completed', 'error': None})


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


def test_new_stream_waits_for_actual_summary_without_legacy_placeholder(monkeypatch):
    monkeypatch.setattr(module, 'generation_storage', SimpleNamespace(
        get_generation=AsyncMock(return_value={'status': 'processing', 'user_id': 'owner', 'user_type': 'anonymous'})))
    monkeypatch.setattr(module, 'read_output', AsyncMock(return_value=None))
    async def run():
        stream = module.output_events('job', {'user_id': 'owner'})
        event = await anext(stream)
        await stream.aclose()
        return json.loads(event[6:])
    snapshot = asyncio.run(run())
    assert snapshot['text'] == '' and snapshot['summary'] == ''


def test_output_storage_uses_stable_path_and_replays_json(monkeypatch):
    monkeypatch.setattr(module, 'LOCAL_DB_ENABLED', True)
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


def test_remote_output_uses_fresh_private_signatures_to_avoid_stale_upsert_cache(monkeypatch):
    bucket = Mock()
    base = 'https://storage.example/storage/v1/object/sign/generation-output/job/llm-output.json'
    bucket.create_signed_url.side_effect = [{'signedURL': base + '?token=first'}, {'signedURL': base + '?token=second'}]
    storage = SimpleNamespace(client=SimpleNamespace(storage=Mock()))
    storage.client.storage.from_.return_value = bucket
    monkeypatch.setattr(module, 'generation_storage', storage)
    monkeypatch.setattr(module, 'LOCAL_DB_ENABLED', False)
    monkeypatch.setattr(module, 'SUPABASE_URL', 'https://storage.example')
    requests = []
    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={'text': '', 'summary': 'First activity' if request.url.params['token'] == 'first' else 'New activity'})
    transport = httpx.MockTransport(respond)
    client = httpx.AsyncClient
    monkeypatch.setattr(module.httpx, 'AsyncClient', lambda **kwargs: client(transport=transport, **kwargs))
    assert asyncio.run(module.read_output('job'))['summary'] == 'First activity'
    assert asyncio.run(module.read_output('job'))['summary'] == 'New activity'
    assert bucket.create_signed_url.call_count == 2
    bucket.create_signed_url.assert_called_with('job/llm-output.json', 30)
    bucket.download.assert_not_called()
    assert all('authorization' not in request.headers for request in requests)


def test_output_signature_cannot_redirect_reader_to_an_untrusted_origin(monkeypatch):
    bucket = Mock()
    bucket.create_signed_url.return_value = {'signedURL': 'https://untrusted.example/file'}
    storage = SimpleNamespace(client=SimpleNamespace(storage=Mock()))
    storage.client.storage.from_.return_value = bucket
    monkeypatch.setattr(module, 'generation_storage', storage)
    monkeypatch.setattr(module, 'LOCAL_DB_ENABLED', False)
    monkeypatch.setattr(module, 'SUPABASE_URL', 'https://storage.example')
    with pytest.raises(ValueError, match='Unexpected private output storage URL'):
        asyncio.run(module.read_output('job'))


def test_recorder_bounds_output_size():
    recorder = module.OutputRecorder('job')
    asyncio.run(recorder.append('a' * (module.MAX_OUTPUT_CHARS + 10)))
    assert len(recorder.text) == module.MAX_OUTPUT_CHARS
    assert len(recorder.pending) == module.MAX_PROGRESS_INPUT_CHARS


def test_summaries_replace_current_activity_using_only_new_output(monkeypatch):
    summarize = AsyncMock(side_effect=['Shaping the lizard tail', 'Checking the feet'])
    monkeypatch.setattr(module, 'summarize_progress', summarize)
    monkeypatch.setattr(module, 'write_output', AsyncMock())

    async def run():
        recorder = module.OutputRecorder('job', design_context='A lizard')
        worker = asyncio.create_task(recorder.run_summaries())
        try:
            await recorder.append('I need to curve the tail around the body.\n\n')
            while not recorder.summary:
                await asyncio.sleep(0)
            await recorder.flush()
            assert module.write_output.await_args.args[1]['summary'] == 'Shaping the lizard tail'
            await recorder.append('The feet should be wide enough for balance.')
            recorder.stopped.set()
            recorder.summary_ready.set()
            await worker
            await recorder.flush()
            assert module.write_output.await_args.args[1]['summary'] == 'Checking the feet'
            assert [call.args[0] for call in summarize.await_args_list] == [
                'I need to curve the tail around the body.\n\n',
                'The feet should be wide enough for balance.',
            ]
            assert 'Subject: A lizard' in summarize.await_args_list[0].kwargs['design_context']
        finally:
            worker.cancel()
            await asyncio.gather(worker, return_exceptions=True)
    asyncio.run(asyncio.wait_for(run(), 2))


def test_slow_summary_does_not_block_new_deltas_or_storage(monkeypatch):
    async def run():
        started, release = asyncio.Event(), asyncio.Event()
        async def summarize(text, previous_summary, design_context):
            started.set()
            await release.wait()
            return 'Shaping the lizard tail'
        monkeypatch.setattr(module, 'summarize_progress', summarize)
        monkeypatch.setattr(module, 'write_output', AsyncMock())
        recorder = module.OutputRecorder('job')
        worker = asyncio.create_task(recorder.run_summaries())
        try:
            await recorder.append('Tail proportions\n\n')
            await started.wait()
            await recorder.append(' and feet')
            await recorder.flush()
            assert recorder.text == 'Tail proportions\n\n and feet'
            assert recorder.pending == ' and feet'
            assert module.write_output.await_args.args[1]['summary'] == ''
        finally:
            recorder.stopped.set()
            recorder.summary_ready.set()
            release.set()
            await worker
    asyncio.run(asyncio.wait_for(run(), 2))


def test_summary_failure_keeps_the_previous_activity_and_build_succeeds(monkeypatch):
    monkeypatch.setattr(module, 'summarize_progress', AsyncMock(side_effect=TimeoutError()))
    monkeypatch.setattr(module, 'write_output', AsyncMock())
    async def run():
        recorder = module.OutputRecorder('job')
        recorder.summary = 'Shaping the tail'
        await recorder.append('New design output')
        recorder.stopped.set()
        await recorder.run_summaries()
        assert recorder.summary == 'Shaping the tail'
    asyncio.run(run())
    async def generate(id, on_text):
        await on_text('New design output')
    asyncio.run(module.run_with_output('job', generate))
    assert module.write_output.await_args.args[1]['status'] == 'completed'


def test_cancelling_generation_stops_an_inflight_summary(monkeypatch):
    async def run():
        started, cancelled = asyncio.Event(), asyncio.Event()
        async def summarize(text, previous_summary, design_context):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        async def generate(id, on_text):
            await on_text('Shaping a lizard\n\n')
            await asyncio.Event().wait()
        monkeypatch.setattr(module, 'summarize_progress', summarize)
        monkeypatch.setattr(module, 'write_output', AsyncMock())
        producer = asyncio.create_task(module.run_with_output('job', generate))
        await started.wait()
        producer.cancel()
        with pytest.raises(asyncio.CancelledError):
            await producer
        assert cancelled.is_set()
        assert module.write_output.await_args.args[1]['status'] == 'cancelled'
    asyncio.run(asyncio.wait_for(run(), 2))
