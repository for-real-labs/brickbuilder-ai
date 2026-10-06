"""Private transport and artifact export around the unmodified Nova web backend."""
from __future__ import annotations

import asyncio
import hmac
import io
import json
import os
import pwd
import subprocess
import tempfile
import zipfile
import uuid
from pathlib import Path

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from main import app
import agent
import settings
import llm_config
import litellm
import claude_agent
from brickbuilder_integration.cost_limits import install_cost_limits
from store import get_store
from leocad_render import bom_path_for, snapshot_path_for

MAX_EXPORT_BYTES = 64 * 1024 * 1024
VERSIONS = json.loads(Path(__file__).with_name('versions.json').read_text())
install_cost_limits(agent, llm_config, litellm, claude_agent)
VERSIONS['generation_cost_limit_usd'] = 10


@app.middleware('http')
async def private_runtime(request: Request, call_next):
    token = os.environ.get('NOVA_SERVICE_TOKEN', '')
    supplied = request.headers.get('authorization', '')
    if not token or not hmac.compare_digest(supplied, 'Bearer ' + token):
        return JSONResponse({'detail': 'Private Nova runtime'}, status_code=401)
    return await call_next(request)


@app.get('/integration/runtime')
def runtime():
    return VERSIONS


class ImportedModel(BaseModel):
    model: str = Field(min_length=1, max_length=16 * 1024 * 1024)
    llm_model_id: str = Field(min_length=1, max_length=64, pattern=r'^[A-Za-z0-9_-]+$')


def import_model(body: ImportedModel) -> dict:
    # Only geometry crosses owners. The caller selects this tenant's provider.
    if len(body.model.encode('utf-8')) > 16 * 1024 * 1024:
        raise HTTPException(413, 'Model is too large')
    placements = 0
    for line in body.model.splitlines():
        tokens = line.split()
        if tokens and tokens[0] == '1':
            placements += 1
            reference = tokens[-1].replace('\\', '/')
            if len(tokens) < 15 or reference.startswith('/') or ':' in reference or '..' in reference.split('/'):
                raise HTTPException(400, 'Invalid model reference')
    if not placements:
        raise HTTPException(400, 'Model contains no parts')
    from sandbox import give_to_agent
    store = get_store()
    chat = store.create_chat('Model copy', body.llm_model_id)
    model = settings.GENERATED_DIR / f'imported-{uuid.uuid4()}.ldr'
    model.write_text(body.model, encoding='utf-8')
    give_to_agent(model)
    ref = store.add_model(chat['id'], 'Imported model', model, [])
    work = store.work_dir(chat['id'])
    editable = work / 'model.ldr'
    editable.write_text(body.model, encoding='utf-8')
    give_to_agent(editable)
    notes = 'This workspace contains an independent copy of a completed public model. Read model.ldr and modify this existing geometry for the next edit request. Preserve custom color definitions and publish the revised model with Nova tools.'
    (work / 'NOTES.md').write_text(notes, encoding='utf-8')
    give_to_agent(work / 'NOTES.md')
    store.add_message(chat['id'], {'role': 'user', 'content': notes})
    return {'id': chat['id'], 'model_id': ref['id']}


@app.post('/integration/import')
async def import_geometry(body: ImportedModel):
    return await asyncio.to_thread(import_model, body)


def export_sources(chat_id: str, model_id: str) -> bytes:
    store = get_store()
    if not store.get_chat(chat_id):
        raise HTTPException(404, 'Nova session not found')
    if agent.is_running(chat_id):
        raise HTTPException(409, 'Nova is still working on this session')
    ref = next((row for row in store.models(chat_id) if row['id'] == model_id), None)
    if ref is None:
        raise HTTPException(404, 'Nova model not found')
    model = store.resolve(chat_id, ref['model']).resolve()
    if model.parent != settings.GENERATED_DIR.resolve() or not model.is_file():
        raise HTTPException(404, 'Nova model source not found')
    files = {'model.mpd': model, 'preview.png': snapshot_path_for(model),
             'nova-bom.csv': bom_path_for(model)}
    work = store.work_dir(chat_id).resolve()
    # Keep generators, plans, references and review evidence for reproducibility.
    # Never include /config, hidden runtime state or a symlink outside this chat.
    for path in work.rglob('*'):
        relative = path.relative_to(work)
        if any(part.startswith('.') and part != '.scripts' for part in relative.parts) or path.is_symlink():
            continue
        if path.is_file() and path.resolve().is_relative_to(work):
            files['workspace/' + relative.as_posix()] = path
    if len(files) > 2000:
        raise HTTPException(413, 'Nova source archive contains too many files')
    with tempfile.TemporaryDirectory(prefix='nova-export-') as directory:
        flat = Path(directory) / 'model.ldr'
        account = pwd.getpwnam(os.environ['LDRAW_NOVA_AGENT_USER'])
        os.chown(directory, account.pw_uid, account.pw_gid)
        try:
            subprocess.run([str(settings.TOOLKIT_DIR / '.venv/bin/python'),
                            str(Path(__file__).with_name('flatten.py')), str(model), str(flat),
                            str(settings.LDRAW_DIR)], cwd=settings.TOOLKIT_DIR,
                           user=account.pw_uid, group=account.pw_gid, extra_groups=[],
                           env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'PYTHONPATH': str(settings.TOOLKIT_DIR),
                                'PYTHONDONTWRITEBYTECODE': '1', 'HOME': str(store.work_dir(chat_id))},
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=120)
            flat_data = flat.read_bytes()
        except (OSError, subprocess.SubprocessError):
            raise HTTPException(502, 'Nova display export failed') from None
    total = len(flat_data)
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('model.ldr', flat_data)
        archive.writestr('runtime.json', json.dumps(VERSIONS))
        archive.writestr('publication.json', json.dumps(ref))
        # This is an owner-only archive. Provider settings and credentials are excluded.
        history = json.dumps(store.messages(chat_id), ensure_ascii=False).encode()
        total += len(history)
        if total > MAX_EXPORT_BYTES:
            raise HTTPException(413, 'Nova source archive exceeds its size limit')
        archive.writestr('conversation.json', history)
        for name, path in files.items():
            if not path.is_file():
                continue
            remaining = MAX_EXPORT_BYTES - total
            with path.open('rb') as handle:
                data = handle.read(remaining + 1)
            total += len(data)
            if total > MAX_EXPORT_BYTES:
                raise HTTPException(413, 'Nova source archive exceeds its size limit')
            archive.writestr(name, data)
    return output.getvalue()


@app.get('/integration/chats/{chat_id}/export/{model_id}')
async def export(chat_id: str, model_id: str):
    data = await asyncio.to_thread(export_sources, chat_id, model_id)
    return Response(data, media_type='application/zip', headers={'Cache-Control': 'private, no-store'})


@app.post('/integration/auth/{provider}/cancel')
async def cancel_login(provider: str):
    if provider not in {'openai', 'anthropic'}:
        raise HTTPException(404, 'Unknown provider')
    import browser_auth
    await browser_auth._stop(provider)
    browser_auth._sessions.pop(provider, None)
    return {'cancelled': True}

# Nova registers its frontend SPA fallback before this adapter is imported.
# Keep integration endpoints ahead of that fallback so exports cannot return HTML.
integration_routes = [route for route in app.router.routes if getattr(route, 'path', '').startswith('/integration/')]
app.router.routes[:] = integration_routes + [route for route in app.router.routes if route not in integration_routes]
