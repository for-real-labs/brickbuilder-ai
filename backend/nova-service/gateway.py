"""Private tenant routing to isolated processes of the unchanged Nova backend.

Each owner gets Nova's own ChatStore, provider config and Unix sandbox account.
Only the authenticated BrickBuilder server may select a tenant; the public UI
never receives the runtime token or a direct runtime URL.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import os
import pwd
import re
import signal
import shutil
import time
import socket
import subprocess
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse, Response
from starlette.background import BackgroundTask

TOKEN = os.environ.get('NOVA_SERVICE_TOKEN', '')
TENANT_RE = re.compile(r'^[a-f0-9]{64}$')
VERSIONS = json.loads(Path(__file__).with_name('versions.json').read_text())
_workers = {}
_locks = {}
_capacity_lock = asyncio.Lock()
_last_used = {}


async def stop_worker(process):
    if process.returncode is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            await asyncio.wait_for(process.wait(), 15)
        except asyncio.TimeoutError:
            os.killpg(process.pid, signal.SIGKILL)
            await process.wait()


@asynccontextmanager
async def lifespan(app):
    app.state.client = httpx.AsyncClient(timeout=httpx.Timeout(180, connect=10), follow_redirects=False)
    yield
    await asyncio.gather(*(stop_worker(process) for process, _ in _workers.values()))
    await app.state.client.aclose()


app = FastAPI(lifespan=lifespan)


def prepare_tenant(tenant):
    account = 'nova_' + tenant[:24]
    try:
        user = pwd.getpwnam(account)
    except KeyError:
        uid = 200000 + int(tenant[:7], 16)
        subprocess.run(['groupadd', '--gid', str(uid), account], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['useradd', '--uid', str(uid), '--gid', str(uid), '--no-create-home', '--shell', '/bin/bash', account], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        user = pwd.getpwnam(account)
    data = Path('/data/tenants') / tenant
    config = Path(os.environ.get('NOVA_CONFIG_ROOT', '/config')) / 'tenants' / tenant
    data.mkdir(parents=True, exist_ok=True)
    os.chown(data, 0, user.pw_gid)
    os.chmod(data, 0o710)
    output = data / 'output'
    output.mkdir(exist_ok=True)
    os.chown(output, 0, user.pw_gid)
    os.chmod(output, 0o710)
    config.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(config, 0o700)
    toolkit = data / ('toolkit-' + VERSIONS['toolkit'])
    if not (toolkit / 'ldraw_tools/cli.py').is_file() or not (toolkit / '.cache').is_dir():
        if toolkit.exists():
            for directory, subdirs, files in os.walk(toolkit):
                os.chmod(directory, 0o755)
            shutil.rmtree(toolkit)
        toolkit.mkdir()
        # Copy the small immutable Python package so its upstream ROOT resolves inside
        # this tenant; symlink the large read-only reference corpus and runtime.
        source = Path('/opt/ldraw-nova')
        shutil.copytree(source / 'ldraw_tools', toolkit / 'ldraw_tools')
        for entry in source.iterdir():
            if entry.name not in {'ldraw_tools', '.cache', 'output'}:
                (toolkit / entry.name).symlink_to(entry, target_is_directory=entry.is_dir())
        cache = toolkit / '.cache'
        cache.mkdir()
        os.chown(cache, user.pw_uid, user.pw_gid)
        os.chmod(cache, 0o700)
    # Upstream keeps repository-shaped workspace links across turns. Point
    # existing sessions at this installation's new pin when the image upgrades.
    chats = data / 'chats'
    if chats.is_dir():
        for chat in chats.iterdir():
            workspace = chat / 'workspace'
            if chat.is_symlink() or workspace.is_symlink() or not workspace.is_dir():
                continue
            for entry in toolkit.iterdir():
                link = workspace / entry.name
                if link.is_symlink():
                    link.unlink()
                    link.symlink_to(entry, target_is_directory=entry.is_dir())
    return account, data, config, toolkit


async def worker_url(tenant):
    async with _locks.setdefault(tenant, asyncio.Lock()), _capacity_lock:
        _last_used[tenant] = time.monotonic()
        current = _workers.get(tenant)
        if current and current[0].returncode is None:
            return current[1]
        # Bound memory/process use. Existing tenants remain persistent on disk.
        active = sum(process.returncode is None for process, _ in _workers.values())
        if active >= int(os.environ.get('NOVA_MAX_WORKERS', '16')):
            # Reclaim idle processes while retaining their durable sessions.
            async with httpx.AsyncClient(headers={'Authorization': 'Bearer ' + TOKEN}, timeout=5) as client:
                for old in sorted(_workers, key=lambda key: _last_used.get(key, 0)):
                    process, old_url = _workers[old]
                    if process.returncode is not None or time.monotonic() - _last_used.get(old, 0) < 60:
                        continue
                    try:
                        state = await client.get(old_url + '/api/chats')
                        if state.status_code == 200 and not any(chat.get('running') for chat in state.json()['chats']):
                            await stop_worker(process)
                            break
                    except (httpx.HTTPError, ValueError, KeyError):
                        continue
                else:
                    raise RuntimeError('Nova runtime is at capacity')
        account, data, config, toolkit = await asyncio.to_thread(prepare_tenant, tenant)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        env = {**os.environ, 'LDRAW_NOVA_AGENT_USER': account,
               'LDRAW_NOVA_CLAUDE_API_RUNTIME': 'sdk',
               'LDRAW_NOVA_TOOLKIT_DIR': str(toolkit), 'LDRAW_NOVA_DATA_DIR': str(data), 'LDRAW_NOVA_WEB_CONFIG_DIR': str(config)}
        process = await asyncio.create_subprocess_exec(
            'python3', '-m', 'uvicorn', 'brickbuilder_integration.worker:app',
            '--app-dir', '/app/web/backend', '--host', '127.0.0.1', '--port', str(port),
            env=env, start_new_session=True)
        url = f'http://127.0.0.1:{port}'
        try:
            async with httpx.AsyncClient(headers={'Authorization': 'Bearer ' + TOKEN}) as client:
                for _ in range(120):
                    if process.returncode is not None:
                        raise RuntimeError('Nova worker could not start')
                    try:
                        response = await client.get(url + '/integration/runtime')
                        if response.status_code == 200 and response.headers.get('content-type', '').startswith('application/json') and response.json() == VERSIONS:
                            _workers[tenant] = (process, url)
                            return url
                    except httpx.HTTPError:
                        pass
                    await asyncio.sleep(0.5)
            raise RuntimeError('Nova worker startup timed out')
        except BaseException:
            await stop_worker(process)
            raise


@app.post('/integration/instructions')
async def instruction_export(request: Request):
    if not TOKEN or not hmac.compare_digest(request.headers.get('authorization', ''), 'Bearer ' + TOKEN):
        return JSONResponse({'detail': 'Private Nova runtime'}, status_code=401)
    source = bytearray()
    async for chunk in request.stream():
        source.extend(chunk)
        if len(source) > 16 * 1024 * 1024:
            return JSONResponse({'detail': 'Model is too large'}, status_code=413)
    try:
        source.decode('utf-8')
        data = await asyncio.to_thread(export_instruction_placements, bytes(source))
    except (UnicodeError, OSError, subprocess.SubprocessError, ValueError):
        return JSONResponse({'detail': 'Nova construction steps could not be exported'}, status_code=502)
    return Response(data, media_type='text/plain')


def export_instruction_placements(source: bytes) -> bytes:
    # Parse geometry using the installed Nova toolkit in a fresh unprivileged
    # workspace. No owner worker, provider configuration or agent is started.
    account = pwd.getpwnam('nobody')
    toolkit = Path('/opt/ldraw-nova')
    with tempfile.TemporaryDirectory(prefix='nova-instructions-') as directory:
        root = Path(directory)
        os.chown(root, account.pw_uid, account.pw_gid)
        model, output = root / 'model.mpd', root / 'instructions.ldr'
        model.write_bytes(source)
        subprocess.run([str(toolkit / '.venv/bin/python'), str(Path(__file__).with_name('flatten.py')),
                        str(model), str(output), os.getenv('LDRAW_DIR', '/opt/ldraw/ldraw'), '--instructions'],
                       cwd=toolkit, user=account.pw_uid, group=account.pw_gid, extra_groups=[],
                       env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'PYTHONPATH': str(toolkit),
                            'PYTHONDONTWRITEBYTECODE': '1', 'HOME': str(root)},
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=120)
        if output.stat().st_size > 32 * 1024 * 1024:
            raise ValueError('Instruction export is too large')
        return output.read_bytes()


@app.api_route('/{path:path}', methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
async def proxy(path: str, request: Request):
    if not TOKEN or not hmac.compare_digest(request.headers.get('authorization', ''), 'Bearer ' + TOKEN):
        return JSONResponse({'detail': 'Private Nova runtime'}, status_code=401)
    tenant = request.headers.get('x-nova-tenant', '')
    if not TENANT_RE.fullmatch(tenant):
        return JSONResponse({'detail': 'Invalid Nova tenant'}, status_code=400)
    if path == 'integration/runtime' and request.method == 'GET':
        return JSONResponse(VERSIONS)
    try:
        url = await worker_url(tenant)
        # Bounded request bodies; no arbitrary destinations or forwarded browser headers.
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 16 * 1024 * 1024:
                return JSONResponse({'detail': 'Nova request is too large'}, status_code=413)
        outgoing = app.state.client.build_request(request.method, url + '/' + path,
            params=request.query_params, content=bytes(body), headers={
                'Authorization': 'Bearer ' + TOKEN, 'Content-Type': request.headers.get('content-type', 'application/json')})
        response = await app.state.client.send(outgoing, stream=True)
    except (RuntimeError, httpx.HTTPError, OSError):
        return JSONResponse({'detail': 'Nova worker is unavailable or at capacity'}, status_code=503)
    return StreamingResponse(response.aiter_raw(), status_code=response.status_code,
        headers={name: value for name, value in response.headers.items()
                 if name.lower() in {'content-type', 'content-length', 'content-encoding', 'cache-control', 'content-disposition'}},
        background=BackgroundTask(response.aclose))
