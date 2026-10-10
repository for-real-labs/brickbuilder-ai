"""Private tenant routing to isolated processes of the unchanged Nova backend.

Each owner gets Nova's own ChatStore, provider config and Unix sandbox account.
Only the authenticated BrickBuilder server may select a tenant; the public UI
never receives the runtime token or a direct runtime URL.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import pwd
import re
import signal
import shutil
import time
import socket
import struct
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
VERSIONS['generation_cost_limit_usd'] = 10
VERSIONS['generation_usage_version'] = 1
VERSIONS['parts_catalog_version'] = 1
_workers = {}
_locks = {}
_capacity_lock = asyncio.Lock()
_last_used = {}
TENANTS_ROOT = Path('/data/tenants')
CACHE_RETENTION_SECONDS = 7 * 24 * 60 * 60
CACHE_SWEEP_SECONDS = 60 * 60
SEARCH_CACHES = ('discovery', 'jev-rerank', 'reference-search')
REFERENCE_ROOT = Path('/data/reference-cache')
REFERENCE_SOCKET = Path('/run/nova-reference.sock')
_reference_lock = asyncio.Lock()
_agent_tenants = {}
logger = logging.getLogger(__name__)


async def reference_request(reader, writer):
    """Local agents can search public references, never select files or commands."""
    process = None
    try:
        sock = writer.get_extra_info('socket')
        _, uid, _ = struct.unpack('3i', sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        tenant = _agent_tenants.get(uid)
        if tenant is None:
            raise ValueError('Unknown reference caller')
        payload = await asyncio.wait_for(reader.readline(), 5)
        if len(payload) > 65536 or not payload.endswith(b'\n'):
            raise ValueError('Invalid reference request')
        # Validate before starting a privileged process. It can only access the
        # immutable public corpus, using bounded search options.
        from brickbuilder_integration.shared_reference import validate
        validate(json.loads(payload))
        async with _reference_lock:
            mark_cache_used(tenant)
            env = {'PATH': os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'),
                   'PYTHONPATH': '/opt/ldraw-nova', 'PYTHONDONTWRITEBYTECODE': '1',
                   'LDRAW_DIR': '/opt/ldraw/ldraw', 'HOME': '/root'}
            process = await asyncio.create_subprocess_exec('/opt/ldraw-nova/.venv/bin/python',
                str(Path(__file__).with_name('shared_reference.py')),
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL, env=env, start_new_session=True)
            output, _ = await asyncio.wait_for(process.communicate(payload), 290)
            if len(output) > 32 * 1024 * 1024:
                raise ValueError('Reference response is too large')
            writer.write(output)
            await writer.drain()
    except Exception:
        writer.write(b'{"error":"Shared reference search is unavailable."}')
        await writer.drain()
    finally:
        if process and process.returncode is None:
            await stop_worker(process)
        writer.close()
        await writer.wait_closed()


def mark_cache_used(tenant):
    """Persist owner activity across deployments, without exposing session data."""
    data = TENANTS_ROOT / tenant
    if data.is_dir() and not data.is_symlink():
        marker = data / '.cache-last-used'
        if marker.is_symlink():
            raise OSError('Cache activity marker must not be a symlink')
        marker.touch()


def search_cache_paths(data):
    for toolkit in data.glob('toolkit-*'):
        cache = toolkit / '.cache'
        if toolkit.is_symlink() or cache.is_symlink():
            continue
        for name in SEARCH_CACHES:
            path = cache / name
            if path.is_dir() and not path.is_symlink():
                yield path


def cache_last_used(data, caches):
    marker = data / '.cache-last-used'
    if marker.is_file() and not marker.is_symlink():
        return marker.stat().st_mtime
    # Existing installations have no marker. Use the newest cache write rather
    # than treating every pre-existing owner as inactive on first deployment.
    newest = data.stat().st_mtime
    for cache in caches:
        for root, dirs, files in os.walk(cache, followlinks=False):
            newest = max(newest, Path(root).stat().st_mtime)
            for name in files:
                newest = max(newest, (Path(root) / name).lstat().st_mtime)
    return newest


async def expire_search_caches():
    """Evict only reproducible indexes, after checking and stopping idle workers."""
    async with _capacity_lock:
        for data in TENANTS_ROOT.iterdir() if TENANTS_ROOT.is_dir() else ():
            if not TENANT_RE.fullmatch(data.name) or data.is_symlink() or not data.is_dir():
                continue
            try:
                caches = list(search_cache_paths(data))
                # Private result files expire individually, including for owners
                # who stay active but no longer use an older search.
                for cache in caches:
                    if cache.name == 'reference-search':
                        for result in cache.glob('*.json'):
                            if not result.is_symlink() and time.time() - result.stat().st_mtime >= CACHE_RETENTION_SECONDS:
                                result.unlink()
                if not caches or time.time() - cache_last_used(data, caches) < CACHE_RETENTION_SECONDS:
                    continue
                current = _workers.get(data.name)
                if current and current[0].returncode is None:
                    response = await app.state.client.get(current[1] + '/api/chats',
                        headers={'Authorization': 'Bearer ' + TOKEN}, timeout=5)
                    response.raise_for_status()
                    chats = response.json()['chats']
                    if not isinstance(chats, list) or any(chat.get('running') for chat in chats):
                        continue
                    await stop_worker(current[0])
                _workers.pop(data.name, None)
                _last_used.pop(data.name, None)
                for cache in caches:
                    # rmtree does not follow child symlinks. Preserve the .cache
                    # directory, embedded model parts, workspaces and credentials.
                    await asyncio.to_thread(shutil.rmtree, cache)
                logger.info('Expired search caches for inactive Nova owner %s', data.name)
            except (OSError, httpx.HTTPError, ValueError, KeyError, TypeError):
                logger.exception('Could not expire Nova search caches for %s', data.name)
        async with _reference_lock:
            if not REFERENCE_ROOT.is_dir():
                return
            for version in REFERENCE_ROOT.iterdir():
                if version.is_symlink() or not version.is_dir() or not re.fullmatch(r'[a-f0-9]{40}', version.name):
                    continue
                # Each filtered public collection expires independently, even
                # while other collections or owners continue to use the catalog.
                collections = version / '.cache/jev-rerank'
                if collections.is_dir() and not collections.is_symlink():
                    for collection in collections.iterdir():
                        stamp = collection / '.last-used'
                        if collection.is_symlink() or not re.fullmatch(r'[a-f0-9]{64}', collection.name):
                            continue
                        if not stamp.is_file() or time.time() - stamp.stat().st_mtime < CACHE_RETENTION_SECONDS:
                            continue
                        await asyncio.to_thread(shutil.rmtree, collection)
                        for snapshot in (version / '.cache/discovery').glob('*/queries/' + collection.name + '.sqlite'):
                            snapshot.unlink()
                marker = version / '.last-used'
                if not marker.is_file() or marker.is_symlink() or time.time() - marker.stat().st_mtime < CACHE_RETENTION_SECONDS:
                    continue
                # An agent may hold a read-only catalog handle between tools.
                # Evict only after every resident owner is confirmed idle.
                idle = []
                try:
                    for tenant, (process, url) in _workers.items():
                        if process.returncode is not None:
                            continue
                        response = await app.state.client.get(url + '/api/chats',
                            headers={'Authorization': 'Bearer ' + TOKEN}, timeout=5)
                        response.raise_for_status()
                        if any(chat.get('running') for chat in response.json()['chats']):
                            break
                        idle.append(tenant)
                    else:
                        for tenant in idle:
                            await stop_worker(_workers.pop(tenant)[0])
                        await asyncio.to_thread(shutil.rmtree, version)
                        logger.info('Expired unused Nova reference index version %s', version.name)
                except (OSError, httpx.HTTPError, ValueError, KeyError, TypeError):
                    logger.exception('Could not expire Nova shared reference indexes')


async def cache_sweeper():
    while True:
        try:
            await expire_search_caches()
        except Exception:
            logger.exception('Nova cache sweep failed; retrying next hour')
        await asyncio.sleep(CACHE_SWEEP_SECONDS)


async def migrate_duplicate_indexes():
    """At container startup no agents exist yet; reclaim legacy public indexes."""
    if _workers or not TENANTS_ROOT.is_dir():
        return
    for data in TENANTS_ROOT.iterdir():
        if data.is_symlink() or not data.is_dir() or not TENANT_RE.fullmatch(data.name):
            continue
        for cache in search_cache_paths(data):
            if cache.name in {'discovery', 'jev-rerank'}:
                try:
                    await asyncio.to_thread(shutil.rmtree, cache)
                except OSError:
                    logger.exception('Could not migrate legacy Nova search cache')


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
    await migrate_duplicate_indexes()
    sweeper = asyncio.create_task(cache_sweeper())
    reference_server = None
    try:
        if os.name == 'posix' and hasattr(socket, 'SO_PEERCRED'):
            REFERENCE_SOCKET.unlink(missing_ok=True)
            reference_server = await asyncio.start_unix_server(reference_request,
                path=str(REFERENCE_SOCKET), limit=65536)
            os.chmod(REFERENCE_SOCKET, 0o666)
        yield
    finally:
        if reference_server:
            reference_server.close()
            await reference_server.wait_closed()
            REFERENCE_SOCKET.unlink(missing_ok=True)
        sweeper.cancel()
        await asyncio.gather(sweeper, return_exceptions=True)
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
    data = TENANTS_ROOT / tenant
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
    # Install thin transport hooks in the owner copy; the pinned source used by
    # the trusted index builder stays unchanged and never imports owner code.
    package = toolkit / 'ldraw_tools'
    shutil.copyfile(Path(__file__).with_name('reference_client.py'), package / '_shared_reference.py')
    for module, install in [('common', 'install_common'), ('discovery', 'install_discovery')]:
        path = package / (module + '.py')
        source = path.read_text()
        if '# BrickBuilder shared references' not in source:
            path.write_text(source + '\n# BrickBuilder shared references\n'
                f'from ._shared_reference import {install} as _install_shared\n'
                f'import sys as _shared_sys\n_install_shared(_shared_sys.modules[__name__])\n')
    _agent_tenants[user.pw_uid] = tenant
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
            mark_cache_used(tenant)
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
        mark_cache_used(tenant)
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
                'Authorization': 'Bearer ' + TOKEN, 'Content-Type': request.headers.get('content-type', 'application/json'),
                **({'X-BrickBuilder-Generation-Id': request.headers['x-brickbuilder-generation-id']}
                   if 'x-brickbuilder-generation-id' in request.headers else {})})
        response = await app.state.client.send(outgoing, stream=True)
    except (RuntimeError, httpx.HTTPError, OSError):
        return JSONResponse({'detail': 'Nova worker is unavailable or at capacity'}, status_code=503)
    return StreamingResponse(response.aiter_raw(), status_code=response.status_code,
        headers={name: value for name, value in response.headers.items()
                 if name.lower() in {'content-type', 'content-length', 'content-encoding', 'cache-control', 'content-disposition'}},
        background=BackgroundTask(response.aclose))
