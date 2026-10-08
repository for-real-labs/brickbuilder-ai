"""Tenant-side adapters: shared public indexes, private expiring result cache."""
import hashlib
import json
import os
from pathlib import Path
import socket
from functools import lru_cache

SOCKET = '/run/nova-reference.sock'


@lru_cache(maxsize=1)
def reference_index():
    return request('index')


def request(action, params=None):
    body = {'action': action, 'params': params or {}}
    if action == 'search':
        body['api_key'] = os.environ.get('TYPESAFE_API_KEY', '')
    payload = json.dumps(body, allow_nan=False).encode() + b'\n'
    if len(payload) > 65536:
        raise ValueError('Reference search request is too large')
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(300)
        client.connect(SOCKET)
        client.sendall(payload)
        response = bytearray()
        while True:
            chunk = client.recv(65536)
            if not chunk:
                break
            response.extend(chunk)
            if len(response) > 32 * 1024 * 1024:
                raise ValueError('Reference response is too large')
    result = json.loads(response)
    if 'error' in result:
        raise ValueError(result['error'])
    return result['result']


def install_common(common):
    original = common.get_parts
    def get_parts(root=None, *, refresh=False, shadows=None):
        # Custom user libraries remain local. Only the installed public corpus
        # crosses the shared indexing boundary.
        if common.library_path(root) != Path('/opt/ldraw/ldraw'):
            return original(root, refresh=refresh, shadows=shadows)
        info = reference_index()
        parts = common.Parts(Path(info['parts_index']))
        for source in common.shadow_paths(shadows):
            parts.add_connection_shadow(source)
        return parts
    common.get_parts = get_parts


def install_discovery(discovery):
    original_init = discovery.DiscoveryIndex.__init__
    original_ensure = discovery.DiscoveryIndex.ensure
    original_inventory = discovery.DiscoveryIndex.inventory
    original_search = discovery.search

    def init(self, parts, root=None, *, database=None, cache=None):
        self._shared_reference = (root is None and database is None and cache is None
            and Path(parts.path).is_relative_to('/data/reference-cache'))
        if self._shared_reference:
            cache = reference_index()['cache']
        original_init(self, parts, root, database=database, cache=cache)

    def ensure(self, *, force=False):
        if self._shared_reference:
            return reference_index()['report']
        return original_ensure(self, force=force)

    def inventory(self, row, *, max_instances=100000):
        if self._shared_reference:
            return request('inventory', {'id': row['id'], 'max_instances': max_instances})
        return original_inventory(self, row, max_instances=max_instances)

    def search(index, kind, query, **kwargs):
        if not index._shared_reference:
            return original_search(index, kind, query, **kwargs)
        params = dict(kind=kind, query=query, **kwargs)
        # Keep query-bearing results private. These small files are evicted by
        # the same seven-day owner inactivity policy as legacy search caches.
        from .common import CACHE, atomic_write
        key = hashlib.sha256(json.dumps(params, sort_keys=True).encode()).hexdigest()
        target = CACHE / 'reference-search' / (key + '.json')
        try:
            result = json.loads(target.read_text())
            os.utime(target, None)
            return result
        except (OSError, ValueError):
            pass
        result = request('search', params)
        atomic_write(target, json.dumps(result))
        return result

    discovery.DiscoveryIndex.__init__ = init
    discovery.DiscoveryIndex.ensure = ensure
    discovery.DiscoveryIndex.inventory = inventory
    discovery.search = search
