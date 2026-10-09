"""Private transport and artifact export around the unmodified Nova web backend."""
from __future__ import annotations

import asyncio
import hmac
import io
import json
import os
import subprocess
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
from brickbuilder_integration.cost_limits import install_cost_limits, current_usage_id
from brickbuilder_integration.build_policy import install_build_policy, review_source, preview_display, REVIEW_VERSION, REVIEW_FAILURE
import tools
from parts_policy import policy as parts_policy, CATALOG_VERSION
from store import get_store
from leocad_render import bom_path_for, snapshot_path_for

MAX_EXPORT_BYTES = 64 * 1024 * 1024
VERSIONS = json.loads(Path(__file__).with_name('versions.json').read_text())
install_cost_limits(agent, llm_config, litellm, claude_agent)
install_build_policy(tools, settings)
VERSIONS['generation_cost_limit_usd'] = 10
VERSIONS['generation_usage_version'] = 1
VERSIONS['parts_catalog_version'] = CATALOG_VERSION
VERSIONS['build_review_version'] = REVIEW_VERSION
VERSIONS['preview_build_version'] = 1


@app.middleware('http')
async def private_runtime(request: Request, call_next):
    token = os.environ.get('NOVA_SERVICE_TOKEN', '')
    supplied = request.headers.get('authorization', '')
    if not token or not hmac.compare_digest(supplied, 'Bearer ' + token):
        return JSONResponse({'detail': 'Private Nova runtime'}, status_code=401)
    usage_id = request.headers.get('x-brickbuilder-generation-id')
    if usage_id:
        try:
            usage_id = str(uuid.UUID(usage_id))
        except ValueError:
            return JSONResponse({'detail': 'Invalid generation identity'}, status_code=400)
    context = current_usage_id.set(usage_id)
    try:
        return await call_next(request)
    finally:
        current_usage_id.reset(context)


@app.get('/integration/runtime')
def runtime():
    return VERSIONS


@app.get('/integration/chats/{chat_id}/usage/{generation_id}')
def generation_usage(chat_id: str, generation_id: uuid.UUID):
    store = get_store()
    if not store.get_chat(chat_id):
        raise HTTPException(404, 'Nova session not found')
    path = store.chat_dir(chat_id) / f'.brickbuilder-usage-{generation_id}.json'
    if not path.is_file():
        raise HTTPException(404, 'Generation usage not found')
    return json.loads(path.read_text())


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
    give_to_agent(work)
    editable = work / 'model.ldr'
    editable.write_text(body.model, encoding='utf-8')
    give_to_agent(editable)
    notes = 'This workspace contains an independent copy of a completed public model. Read model.ldr and modify this existing geometry for the next edit request. Honor the configured parts palette, replacing unsupported parts or custom colors before publishing the revised model with Nova tools.'
    (work / 'NOTES.md').write_text(notes, encoding='utf-8')
    give_to_agent(work / 'NOTES.md')
    store.add_message(chat['id'], {'role': 'user', 'content': notes})
    return {'id': chat['id'], 'model_id': ref['id']}


@app.post('/integration/import')
async def import_geometry(body: ImportedModel):
    return await asyncio.to_thread(import_model, body)


class PartsCatalogRequest(BaseModel):
    csv: str = Field(min_length=1, max_length=16 * 1024 * 1024)


@app.put('/integration/chats/{chat_id}/parts-catalog')
async def configure_parts_catalog(chat_id: str, body: PartsCatalogRequest):
    store = get_store()
    if not store.get_chat(chat_id):
        raise HTTPException(404, 'Nova session not found')
    if agent.is_running(chat_id):
        raise HTTPException(409, 'Nova is working on this session')
    try:
        catalog = parts_policy.configure(store, chat_id, body.csv)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    return {'parts_catalog_version': 1, 'allowed_combinations': len(catalog.parts)}


def export_sources(chat_id: str, model_id: str, build_mode: str = 'verify') -> bytes:
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
    # Capture the revision once. Verified exports independently review these
    # bytes; preview exports carry explicit unchecked metadata and no instructions.
    if model.stat().st_size > 32 * 1024 * 1024:
        raise HTTPException(413, 'Nova model exceeds the review size limit')
    source = model.read_bytes()
    if build_mode == 'preview':
        if ref.get('validation_status') != 'preview':
            raise HTTPException(409, 'This revision was not published as a preview')
        try:
            fixed = {'model.mpd': source, 'model.ldr': preview_display(source, settings.LDRAW_DIR)}
        except (ValueError, OSError, subprocess.SubprocessError):
            raise HTTPException(502, 'Nova preview display export could not finish') from None
    elif build_mode == 'verify':
        try:
            review, reviewed = review_source(source, settings.LDRAW_DIR)
        except (ValueError, OSError, subprocess.SubprocessError):
            raise HTTPException(502, 'Nova build review could not finish; completion is blocked') from None
        if review['passed'] is not True:
            raise HTTPException(422, REVIEW_FAILURE)
        fixed = {'model.mpd': source, 'model.ldr': reviewed['model.ldr'],
                 'nova-instructions.ldr': reviewed['instructions.ldr'],
                 'build-review.json': json.dumps(review).encode()}
    else:
        raise HTTPException(400, 'Unknown Nova build mode')
    fixed['export-mode.json'] = json.dumps({'build_mode': build_mode}).encode()
    files = {'preview.png': snapshot_path_for(model),
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
    total = sum(map(len, fixed.values()))
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, data in fixed.items():
            archive.writestr(name, data)
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
async def export(chat_id: str, model_id: str, build_mode: str = 'verify'):
    data = await asyncio.to_thread(export_sources, chat_id, model_id, build_mode)
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
