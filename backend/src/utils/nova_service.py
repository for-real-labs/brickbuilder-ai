"""Transport adapter to the installed, unmodified Nova agent runtime.

No prompts, tool definitions, model design, validation or render logic belongs
here. Nova owns the conversation and files; BrickBuilder owns the job and imports.
"""
from __future__ import annotations

import asyncio
import io
import hashlib
import json
import os
import re
import zipfile
import logging
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

import httpx
from .generation_budget import current_generation_usage

logger = logging.getLogger(__name__)

MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
ID_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')


class NovaSessionUnavailableError(ValueError):
    """The selected runtime cannot find a saved session or artifact."""


def connection() -> tuple[str, str]:
    url, token = os.getenv('NOVA_SERVICE_URL'), os.getenv('NOVA_SERVICE_TOKEN')
    if not url and not token:
        try:
            saved = json.loads((Path(__file__).resolve().parents[2] / '.nova/connection.json').read_text())
            url, token = saved['url'], saved['token']
        except (OSError, ValueError, KeyError):
            pass
    parsed = urlsplit(url or '')
    if (parsed.scheme not in {'http', 'https'} or not parsed.hostname or parsed.username
            or parsed.password or parsed.query or parsed.fragment or not token):
        raise ValueError('Nova runtime is unavailable. Run npm run setup:nova or configure NOVA_SERVICE_URL and NOVA_SERVICE_TOKEN.')
    return url.rstrip('/') + '/', token


@dataclass(frozen=True)
class NovaResult:
    mpd: str
    ldr: str
    preview: bytes | None
    archive: bytes
    session: dict


def read_export(data: bytes, session: dict) -> NovaResult:
    if len(data) > MAX_ARCHIVE_BYTES:
        raise ValueError('Nova source archive exceeds the import size limit')
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names, total = set(), 0
            for item in archive.infolist():
                path = PurePosixPath(item.filename)
                total += item.file_size
                if (item.filename in names or path.is_absolute() or '..' in path.parts
                        or '\\' in item.filename or total > MAX_ARCHIVE_BYTES or len(names) >= 2000):
                    raise ValueError('Invalid Nova source archive')
                names.add(item.filename)
            if 'publication.json' in names:
                publication = json.loads(archive.read('publication.json'))
                if not isinstance(publication, dict):
                    raise ValueError('Invalid Nova publication metadata')
                if publication.get('validation_status') == 'preview':
                    raise ValueError('Nova returned an earlier unchecked preview. Start a new build.')
            mpd = archive.read('model.mpd').decode('utf-8')
            ldr = archive.read('model.ldr').decode('utf-8')
            preview = archive.read('preview.png') if 'preview.png' in names else None
            if not mpd.strip() or not ldr.strip():
                raise ValueError('Nova published an empty model')
            return NovaResult(mpd, ldr, preview, data, session)
    except (zipfile.BadZipFile, KeyError, UnicodeError) as exc:
        raise ValueError('Nova did not return a complete model source archive') from exc


class NovaService:
    def __init__(self, client: httpx.AsyncClient | None = None, *, tenant_key: str = 'local-native', tenant_id: str | None = None):
        self.tenant = tenant_id or hashlib.sha256(tenant_key.encode()).hexdigest()
        if not re.fullmatch(r'[a-f0-9]{64}', self.tenant):
            raise ValueError('Invalid Nova tenant identity')
        if client is not None:
            self.client = client
        else:
            url, token = connection()
            self.client = httpx.AsyncClient(base_url=url, headers={'Authorization': 'Bearer ' + token, 'X-Nova-Tenant': self.tenant},
                                           timeout=httpx.Timeout(60, connect=10), follow_redirects=False)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.client.aclose()

    async def request(self, method: str, path: str, **kwargs):
        try:
            response = await self.client.request(method, path, **kwargs)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as exc:
            # Never echo upstream bodies: provider configuration may contain keys.
            if exc.response.status_code == 409:
                raise ValueError('Nova is already working on this session. Wait for it to finish before editing again.') from None
            if exc.response.status_code == 404:
                raise NovaSessionUnavailableError('Nova session or artifact is unavailable. Check the runtime data volume.') from None
            raise ValueError('Nova rejected the request. Check its provider connection and runtime configuration.') from None
        except httpx.HTTPError:
            raise ValueError('Cannot reach the Nova runtime. Check that it is running and the private connection is configured.') from None

    async def ready(self) -> dict:
        info = await self.request('GET', 'integration/runtime')
        if info.get('generation_cost_limit_usd') != 10:
            raise ValueError('Nova must be rebuilt with the $10 generation cost limit before All parts can run.')
        if info.get('parts_catalog_version') != 1:
            raise ValueError('Rebuild the Nova runtime with parts catalog restrictions before using All parts.')
        return info

    @staticmethod
    def session_id(value: str) -> str:
        if not isinstance(value, str) or not ID_RE.fullmatch(value):
            raise ValueError('Invalid Nova session identity')
        return value

    async def configure_model(self, model: str, provider: str, auth_mode: str) -> str:
        prefix = 'chatgpt' if auth_mode == 'native' and provider == 'openai' else provider
        model_name = f'{prefix}/{model}'
        params = {'model': model_name}
        if auth_mode == 'api_key':
            key = os.getenv('OPENAI_API_KEY' if provider == 'openai' else 'ANTHROPIC_API_KEY')
            if not key:
                raise ValueError('Attach the selected provider API key in BrickBuilder before using Nova mode.')
            params['api_key'] = key
        else:
            status = await self.request('GET', f'api/auth/{provider}')
            if status.get('status') != 'connected':
                raise ValueError('Sign in to the selected provider in Local provider connections first.')
        entries = await self.request('GET', 'api/llm-models')
        label = f'BrickBuilder {model_name} ({auth_mode})'
        entry = next((row for row in entries['models'] if row.get('model_name') == label), None)
        body = {'model_name': label, 'litellm_params': params,
                'auth_mode': 'browser' if auth_mode == 'native' else 'api_key'}
        result = await self.request('PUT' if entry else 'POST',
                                    'api/llm-models' + ('/' + self.session_id(entry['id']) if entry else ''), json=body)
        # Keep semantic-search configuration in Nova's protected config, out of agent envs.
        if os.getenv('TYPESAFE_API_KEY'):
            env = await self.request('GET', 'api/environment')
            rows = env['variables']
            for row in rows:
                if row['name'] == 'TYPESAFE_API_KEY':
                    row['value'] = os.environ['TYPESAFE_API_KEY']
            await self.request('PUT', 'api/environment', json={'variables': rows})
        return self.session_id(result['id'])

    async def chat(self, chat_id: str) -> dict:
        return await self.request('GET', f'api/chats/{self.session_id(chat_id)}')

    async def cancel(self, chat_id: str):
        await self.request('POST', f'api/chats/{self.session_id(chat_id)}/cancel')

    async def export(self, chat_id: str, model_id: str, session: dict) -> NovaResult:
        path = f'integration/chats/{self.session_id(chat_id)}/export/{self.session_id(model_id)}'
        data = bytearray()
        try:
            async with self.client.stream('GET', path, timeout=180) as response:
                response.raise_for_status()
                if not response.headers.get('content-type', '').startswith('application/zip'):
                    raise ValueError('Nova source-export adapter is unavailable. Rebuild the private runtime.')
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > MAX_ARCHIVE_BYTES:
                        raise ValueError('Nova source archive exceeds the import size limit')
        except httpx.HTTPError:
            raise ValueError('Could not import the published Nova source archive') from None
        return await asyncio.to_thread(read_export, bytes(data), session)

    async def instructions(self, mpd: str) -> str:
        try:
            response = await self.client.post('integration/instructions', content=mpd.encode('utf-8'),
                headers={'Content-Type': 'text/plain'}, timeout=180)
            response.raise_for_status()
            if not response.headers.get('content-type', '').startswith('text/plain') or not response.text.strip():
                raise ValueError('Nova instruction adapter is unavailable. Rebuild the private runtime.')
            return response.text
        except httpx.HTTPError:
            raise ValueError('Could not load Nova construction steps') from None

    async def run(self, request, provider: str, save_session, on_output=None, previous: dict | None = None, *, on_progress=None) -> NovaResult:
        versions = await self.ready()
        model_id = await self.configure_model(request.model, provider, request.auth_mode)
        source = getattr(request, '_nova_source_ldr', None)
        if previous:
            chat_id = self.session_id(previous['chat_id'])
            try:
                before = await self.chat(chat_id)
            except NovaSessionUnavailableError:
                if not source:
                    raise
                # The saved geometry survives runtime/volume changes. Import it
                # into this tenant instead of depending on a missing conversation.
                previous = None
            if previous and before['chat'].get('running'):
                raise ValueError('Nova is already working on this session. Wait before editing it again.')
        if not previous:
            if source:
                created = await self.request('POST', 'integration/import',
                    json={'model': source, 'llm_model_id': model_id})
                chat_id = self.session_id(created['id'])
                before = await self.chat(chat_id)
            else:
                created = await self.request('POST', 'api/chats', json={'llm_model_id': model_id})
                chat_id, before = self.session_id(created['id']), {'models': {}}
        from .supplier_catalog import catalog_path
        from .parts_catalog import PartsCatalog
        catalog_csv = catalog_path().read_text(encoding='utf-8')
        catalog = PartsCatalog.from_csv(catalog_csv)
        palette_csv = catalog.to_palette_csv()
        configured = await self.request('PUT', f'integration/chats/{chat_id}/parts-catalog',
                                        json={'csv': palette_csv})
        if configured.get('parts_catalog_version') != 1:
            raise ValueError('Nova did not confirm the parts catalog restrictions')
        session = {'chat_id': chat_id, 'tenant': self.tenant, 'versions': versions, 'model': request.model,
                   'auth_mode': request.auth_mode, 'options': {'mode': 'agent', 'permissions': 'full'}}
        if not previous and source:
            session['model_id'] = self.session_id(created['model_id'])
        session['parts_catalog'] = {'sha256': hashlib.sha256(catalog_csv.encode()).hexdigest(),
                                   'palette_sha256': hashlib.sha256(palette_csv.encode()).hexdigest(),
                                   'allowed_combinations': len(catalog.parts)}
        await save_session(session)
        text = request.prompt or 'Create a model from the reference image.'
        images = ([f'data:{request.image_media_type};base64,{request.image_base64}'] if request.image_base64 else [])
        started = False
        usage = current_generation_usage.get()
        track_usage = usage is not None and versions.get('generation_usage_version') == 1
        try:
            await self.request('POST', f'api/chats/{chat_id}/messages', json={
                'text': text, 'images': images, 'llm_model_id': model_id, 'options': session['options']},
                **({'headers': {'X-BrickBuilder-Generation-Id': usage.generation_id}} if track_usage else {}))
            started = True
            await self.wait_for_turn(chat_id, on_output, on_progress)
            after = await self.chat(chat_id)
            from .generation_budget import BUDGET_ERROR
            previous_message_id = max((item.get('id', 0) for item in before.get('messages', [])), default=0)
            if any(message.get('_error') and message.get('id', 0) > previous_message_id
                   and message.get('content') == BUDGET_ERROR for message in after.get('messages', [])):
                raise ValueError(BUDGET_ERROR)
            published = [row for key, row in after['models'].items() if key not in before['models']]
            if not published:
                raise ValueError('Nova finished this turn without publishing a model. The session and source files have been retained.')
            if any(m.get('_error') and m.get('id', 0) > max((item.get('id', 0) for item in before.get('messages', [])), default=0) for m in after.get('messages', [])):
                raise ValueError('Nova reported an error after publication. Its session is retained for continuation.')
            latest = max(published, key=lambda row: row.get('created_at', 0))
            session['model_id'] = latest['id']
            await save_session(session)
            result = await self.export(chat_id, latest['id'], session)
            from .parts_catalog import flat_model_inventory, reject_custom_parts
            # Defense in depth: no unsupported model reaches storage or billing,
            # even if the agent or runtime bypassed its publication tool.
            reject_custom_parts(result.mpd)
            catalog.validate(flat_model_inventory(result.ldr))
            return result
        except BaseException:
            # Includes timeout and user cancellation. Never cancel someone else's turn
            # if sending our message lost a race and returned 409.
            if started:
                try:
                    await asyncio.wait_for(asyncio.shield(self.cancel(chat_id)), 15)
                except (ValueError, asyncio.TimeoutError):
                    pass
            raise
        finally:
            if started and track_usage:
                try:
                    report = await asyncio.wait_for(asyncio.shield(self.request('GET',
                        f'integration/chats/{chat_id}/usage/{usage.generation_id}')), 15)
                    if not isinstance(report, dict) or report.get('generation_id') != usage.generation_id:
                        raise ValueError('Nova returned usage for another generation')
                    calls = report.get('calls')
                    if not isinstance(calls, list) or len(calls) > 10000:
                        raise ValueError('Invalid Nova usage')
                    usage.extend(calls)
                except (ValueError, asyncio.TimeoutError):
                    logger.warning('Unable to retrieve Nova generation usage')

    async def wait_for_turn(self, chat_id: str, on_output, on_progress=None):
        last_phase = None
        while True:
            event, data = 'message', []
            try:
                async with self.client.stream('GET', f'api/chats/{chat_id}/stream') as response:
                    response.raise_for_status()
                    async for line in response.aiter_lines():
                        if len(line) > 1_500_000:
                            raise ValueError('Nova sent an oversized event')
                        if line.startswith('event:'):
                            event = line[6:].strip()
                        elif line.startswith('data:'):
                            data.append(line[5:].strip())
                        elif not line and data:
                            payload = json.loads('\n'.join(data))
                            data = []
                            if event == 'turn_error':
                                from .generation_budget import BUDGET_ERROR
                                if payload.get('message') == BUDGET_ERROR:
                                    raise ValueError(BUDGET_ERROR)
                                raise ValueError('Nova could not complete this turn. Check the runtime provider connection; the session is retained.')
                            if event == 'approval':
                                raise ValueError('Nova requires an approval. Use automatic agent permissions for BrickBuilder generations.')
                            message = (payload.get('delta') if event == 'text' else
                                       payload.get('summary') if event == 'progress' else
                                       payload.get('phase') if event == 'activity' else
                                       payload.get('activity', {}).get('phase') if event == 'snapshot' else None)
                            if isinstance(message, str) and message:
                                if on_progress and event != 'text':
                                    await on_progress(message)
                                if on_output:
                                    if event == 'text':
                                        await on_output(message)
                                    elif message != last_phase:
                                        last_phase = message
                                        await on_output(message + '\n\n')
                            if event == 'done' or (event == 'snapshot' and not payload.get('running')):
                                return
                            if event == 'reconnect':
                                break
            except (httpx.HTTPError, json.JSONDecodeError):
                # SSE is a view of a durable Nova job. Reconnect without resubmitting.
                pass
            state = await self.chat(chat_id)
            if not state['chat'].get('running'):
                return
            await asyncio.sleep(1)
