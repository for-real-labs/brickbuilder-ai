"""Provider-scripted smoke test in a prepared Nova image; geometry/rendering are real."""
import asyncio
import json
import logging
import os
import tempfile
import uuid
import zipfile
import io
from pathlib import Path

logging.disable(logging.WARNING)
root = Path(tempfile.mkdtemp(prefix='nova-preview-runtime-'))
root.chmod(0o755)
os.environ['LDRAW_NOVA_DATA_DIR'] = str(root / 'data')
os.environ['LDRAW_NOVA_WEB_CONFIG_DIR'] = str(root / 'config')
os.environ['NOVA_PARTS_CATALOG'] = 'none'
os.environ['NOVA_SERVICE_TOKEN'] = 'smoke-local-only'

import agent
import llm_config
import model_discovery
from litellm.types.utils import (
    ChatCompletionDeltaToolCall, Delta, Function, ModelResponseStream, StreamingChoices, Usage,
)


async def offline(*args, **kwargs):
    raise RuntimeError('Offline smoke test')


model_discovery._fetch_json = offline
header = '0 FILE model.ldr\n'
def brick(x, y):
    return f'1 4 {x} {y} 0 1 0 0 0 1 0 0 0 1 3001.dat\n'
disconnected, connected = header + brick(0, 0) + brick(400, 0), header + brick(0, 0) + brick(0, -24)
responses = [
    ('publish_model', {'path': 'output/model.mpd'}),
    ('write_file', {'path': 'output/model.mpd', 'content': connected}),
    ('publish_model', {'path': 'output/model.mpd'}),
    (None, 'Checks complete.'),
]
calls = []


async def provider(**kwargs):
    name, body = responses[len(calls)]
    calls.append(kwargs)
    if name:
        delta = Delta(tool_calls=[ChatCompletionDeltaToolCall(
            index=0, id='call-' + str(len(calls)), type='function',
            function=Function(name=name, arguments=json.dumps(body)))])
    else:
        delta = Delta(content=body)
    async def stream():
        yield ModelResponseStream(id='smoke', model='fake', choices=[StreamingChoices(index=0, delta=delta)])
        yield ModelResponseStream(id='smoke', model='fake', choices=[],
            usage=Usage(prompt_tokens=100, completion_tokens=10, total_tokens=110))
    return stream()


# Install the normal cost guard around a scripted provider, never a real API call.
agent.litellm.acompletion = provider
from brickbuilder_integration import worker
from brickbuilder_integration.cost_limits import current_usage_id
import main
from store import get_store
import parts_policy


async def run():
    store = get_store()
    entry = llm_config.create({'litellm_params': {'model': 'openai/gpt-5.5', 'api_key': 'smoke-fake-key'},
                              'capabilities': {'tools': True, 'vision': True}})
    chat = store.create_chat(llm_model_id=entry['id'])
    source = store.work_dir(chat['id']) / 'model.mpd'
    source.write_text(disconnected)
    parts_policy.policy.configure(store, chat['id'], 'part_id,color_id,max_quantity\n3001,4,2\n')
    async def turn(body, verify=False):
        generation = str(uuid.uuid4())
        token = current_usage_id.set(generation)
        try:
            if verify:
                await main.chats_verify(chat['id'], body)
            else:
                await main.chats_send(chat['id'], body)
        finally:
            current_usage_id.reset(token)
        await agent._runs[chat['id']].task
        messages = store.messages(chat['id'])
        assert not any(message.get('_error') for message in messages), messages
        usage = worker.generation_usage(chat['id'], uuid.UUID(generation))
        assert usage['calls'], usage
        return usage
    preview_usage = await turn(main.NewMessage(text='Create a preview', llm_model_id=entry['id'],
        options={'mode': 'agent', 'permissions': 'full', 'build_mode': 'preview'}))
    [preview] = store.models(chat['id'])
    assert preview['validation_status'] == 'preview' and len(calls) == 1
    data = await asyncio.to_thread(worker.export_sources, chat['id'], preview['id'], 'preview')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        assert archive.read('model.mpd').decode() == disconnected
        assert 'nova-instructions.ldr' not in archive.namelist()
        assert 'build-review.json' not in archive.namelist()
        assert len([line for line in archive.read('model.ldr').decode().splitlines() if line.startswith('1 ')]) == 2
    print('Preview: one provider round, unchecked geometry export, no instruction cache, usage retained: PASS', flush=True)
    verification_usage = await turn(main.VerifyBuild(llm_model_id=entry['id'], model_id=preview['id'], permissions='full'), True)
    checked = store.models(chat['id'])[-1]
    assert checked['id'] != preview['id'] and checked['validation_status'] == 'passed'
    data = await asyncio.to_thread(worker.export_sources, chat['id'], checked['id'])
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        review = json.loads(archive.read('build-review.json'))
        assert review['passed'] and review['geometry']['optimistic_component_count'] == 1
        assert review['instructions']['failed_step_count'] == 0
        assert archive.read('model.mpd').decode() == connected
        assert archive.read('nova-instructions.ldr')
    assert len(preview_usage['calls']) == 1 and len(verification_usage['calls']) == 3
    assert len(calls) == 4
    print('Verify Build: selected revision, full publication/export gates, checked instructions, usage retained: PASS', flush=True)


asyncio.run(run())
