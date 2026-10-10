"""Exercise the restored complete workflow with real construction and rendering."""
import asyncio
import io
import json
import logging
import os
import tempfile
import uuid
import zipfile
from pathlib import Path

import httpx
from fastapi import HTTPException
from litellm.types.utils import ChatCompletionDeltaToolCall, Delta, Function, ModelResponseStream, StreamingChoices, Usage

logging.disable(logging.WARNING)
root = Path(tempfile.mkdtemp(prefix='nova-standard-runtime-'))
root.chmod(0o755)
os.environ.update(LDRAW_NOVA_DATA_DIR=str(root / 'data'), LDRAW_NOVA_WEB_CONFIG_DIR=str(root / 'config'),
                  NOVA_PARTS_CATALOG='none', NOVA_SERVICE_TOKEN='smoke-local-only')
import agent
import llm_config
import main
import model_discovery
import parts_policy
import tools
import sandbox
os.environ['LDRAW_NOVA_AGENT_USER'] = sandbox.AGENT_USER
from store import get_store
from brickbuilder_integration.cost_limits import current_usage_id

async def offline(*args, **kwargs):
    raise RuntimeError('Offline smoke test')
model_discovery._fetch_json = offline
calls = []
responses = [
    ('run_toolkit', {'arguments': ['build', 'output/plan.json', '--output', 'output/model.mpd', '--report', 'output/build.json']}),
    ('publish_model', {'path': 'output/model.mpd'}),
    ('view_image', {}),
    (None, 'Visual review complete. Done.'),
]

async def provider(**kwargs):
    name, body = responses[len(calls)]
    if name == 'view_image':
        body = {'path': str(next((root / 'data/output').rglob('publication/*/home.png')))}
    calls.append(kwargs)
    delta = Delta(tool_calls=[ChatCompletionDeltaToolCall(index=0, id='call-' + str(len(calls)), type='function',
        function=Function(name=name, arguments=json.dumps(body)))]) if name else Delta(content=body)
    async def stream():
        yield ModelResponseStream(id='smoke', model='fake', choices=[StreamingChoices(index=0, delta=delta)])
        yield ModelResponseStream(id='smoke', model='fake', choices=[], usage=Usage(prompt_tokens=100, completion_tokens=10, total_tokens=110))
    return stream()
agent.litellm.acompletion = provider
# Install the normal cost guard around the scripted provider.
from brickbuilder_integration import gateway, worker

async def run():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=gateway.app), base_url='http://nova',
        headers={'Authorization': 'Bearer smoke-local-only', 'X-Nova-Tenant': 'a' * 64}) as client:
        runtime = (await client.get('/integration/runtime')).json()
        assert runtime == worker.runtime()
        assert 'preview_build_version' not in runtime and 'build_review_version' not in runtime
        assert runtime['generation_cost_limit_usd'] == 10 and runtime['parts_catalog_version'] == 1
    store = get_store()
    entry = llm_config.create({'litellm_params': {'model': 'openai/gpt-5.5', 'api_key': 'smoke-fake-key'},
                              'capabilities': {'tools': True, 'vision': True}})
    chat = store.create_chat(llm_model_id=entry['id'])
    work = store.work_dir(chat['id'])
    plan = {'version': 1, 'author': 'Runtime test', 'sections': [{'name': 'model.ldr', 'description': 'Stacked bricks', 'steps': [
        [{'id': 'base', 'purpose': 'Foundation', 'ref': '3001.dat', 'colour': 4, 'at': [0, 0, 0]}],
        [{'id': 'top', 'purpose': 'Upper brick', 'ref': '3001.dat', 'colour': 4, 'on': 'base'}],
    ]}]}
    (work / 'plan.json').write_text(json.dumps(plan))
    parts_policy.policy.configure(store, chat['id'], 'part_id,color_id,max_quantity\n3001,4,2\n')
    generation = uuid.uuid4()
    token = current_usage_id.set(str(generation))
    try:
        await main.chats_send(chat['id'], main.NewMessage(text='Build stacked bricks', llm_model_id=entry['id'],
            options={'mode': 'agent', 'permissions': 'full', 'build_mode': 'preview'}))
    finally:
        current_usage_id.reset(token)
    await agent._runs[chat['id']].task
    messages = store.messages(chat['id'])
    assert not any(m.get('_error') for m in messages), messages
    assert messages[-1]['content'] == 'Visual review complete. Done.' and len(calls) == 4
    assert 'PREVIEW WORKFLOW OVERRIDE' not in calls[0]['messages'][0]['content']
    publication = json.loads(next(m['content'] for m in messages if m.get('name') == 'publish_model'))
    assert publication['checks_passed'] and publication['validation'] and publication['preview'] and publication['bom']
    assert json.loads((work / 'build.json').read_text())['geometry']['complete']
    assert any(m.get('_images_for_llm') for m in messages)
    [model] = store.models(chat['id'])
    data = await asyncio.to_thread(worker.export_sources, chat['id'], model['id'])
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        assert archive.read('model.mpd') == (work / 'model.mpd').read_bytes()
        assert archive.read('preview.png') and archive.read('nova-bom.csv')
        display = archive.read('model.ldr').decode()
        assert len([line for line in display.splitlines() if line.startswith('1 ')]) == 2
        assert 'export-mode.json' not in archive.namelist()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=gateway.app), base_url='http://nova',
        headers={'Authorization': 'Bearer smoke-local-only', 'X-Nova-Tenant': 'a' * 64}) as client:
        response = await client.post('/integration/instructions', content=(work / 'model.mpd').read_bytes())
        assert response.status_code == 200, response.text
        assert b'0 STEP' in response.content
    assert len(worker.generation_usage(chat['id'], generation)['calls']) == 4
    # Historical preview metadata survives the rollback, but cannot be
    # exported through the restored complete-generation contract.
    legacy = {**model, 'id': 'legacy-preview', 'validation_status': 'preview'}
    with (store.chat_dir(chat['id']) / 'models.jsonl').open('a') as history:
        history.write(json.dumps(legacy) + '\n')
    try:
        worker.export_sources(chat['id'], legacy['id'])
    except HTTPException as exc:
        assert exc.status_code == 409
    else:
        raise AssertionError('An old unchecked preview was exported as a complete generation')
    print('Standard runtime: full build/geometry, publication render/BOM, visual review, final response, source export, instructions and usage: PASS', flush=True)

asyncio.run(run())
