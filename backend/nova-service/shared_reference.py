"""Trusted, serialized public-reference indexing. No user files are accepted."""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import re
import sys


def validate(body):
    if not isinstance(body, dict) or set(body) - {'action', 'params', 'api_key'}:
        raise ValueError('Invalid reference request')
    action, params = body.get('action'), body.get('params', {})
    if not isinstance(params, dict) or action not in {'index', 'search', 'inventory'}:
        raise ValueError('Invalid reference operation')
    key = body.get('api_key', '')
    if not isinstance(key, str) or len(key) > 512:
        raise ValueError('Invalid reference credentials')
    if action == 'index' and params:
        raise ValueError('Reference index takes no parameters')
    if action == 'inventory':
        if set(params) != {'id', 'max_instances'} or not re.fullmatch(r'(part|model|submodel)-[a-f0-9]{24}', params.get('id', '')):
            raise ValueError('Invalid reference identity')
        if type(params['max_instances']) is not int or not 1 <= params['max_instances'] <= 100000:
            raise ValueError('Invalid inventory limit')
    if action == 'search':
        strings = {'kind': {'parts', 'models', 'submodels'}, 'engine': {'fts', 'jev'},
                   'construction': {None, 'system', 'all', 'technic-structure', 'mechanism'}}
        limits = {'limit': (1, 100), 'candidates': (0, 100000), 'pool': (1, 1000),
                  'max_parts': (1, 100000), 'min_parts': (0, 100000), 'parent_cap': (1, 100), 'timeout': (1, 240)}
        allowed = set(strings) | set(limits) | {'query', 'yes', 'no', 'system', 'max_technic_share'}
        if set(params) - allowed or not {'kind', 'query'} <= set(params):
            raise ValueError('Invalid search parameters')
        for name, value in params.items():
            if name in strings and value not in strings[name]:
                raise ValueError('Invalid search choice')
            if name in limits and not (name == 'max_parts' and value is None):
                if type(value) is not int or not limits[name][0] <= value <= limits[name][1]:
                    raise ValueError('Invalid search limit')
            if name in {'query', 'yes', 'no'} and not (name != 'query' and value is None):
                if not isinstance(value, str) or not value.strip() or len(value) > 8192:
                    raise ValueError('Invalid search text')
            if name == 'system' and type(value) is not bool:
                raise ValueError('Invalid search filter')
            if name == 'max_technic_share' and (type(value) not in {int, float} or not math.isfinite(value) or not 0 <= value <= 1):
                raise ValueError('Invalid search filter')
    return action, params, key


def execute(body, cache):
    action, params, key = validate(body)
    # This process imports only the pinned immutable toolkit, never tenant code.
    from ldraw_tools import common, discovery, resources
    common.CACHE = discovery.CACHE = resources.CACHE = cache
    cache.mkdir(parents=True, exist_ok=True)
    (cache.parent / '.last-used').touch()
    os.environ['XDG_CACHE_HOME'] = str(cache)
    os.environ.pop('TYPESAFE_API_KEY', None)
    if key:
        os.environ['TYPESAFE_API_KEY'] = key
    parts = common.get_parts()
    index = discovery.DiscoveryIndex(parts)
    report = index.ensure()
    if action == 'index':
        result = {'report': report, 'cache': str(index.cache), 'parts_index': str(parts.path)}
    elif action == 'inventory':
        result = index.inventory(index.get(params['id']), max_instances=params['max_instances'])
    else:
        # Shared indexes contain public corpus text only. Private query scores
        # must not be persisted in the database that other owners can read.
        original_run = discovery.subprocess.run
        def run(command, **kwargs):
            if command[0] == 'jev-rerank':
                snapshot = Path(command[command.index('--db') + 1])
                collection = cache / 'jev-rerank' / snapshot.stem
                collection.mkdir(parents=True, exist_ok=True)
                (collection / '.last-used').touch()
                command = [*command, '--no-score-cache', '--cache-dir', str(collection)]
            return original_run(command, **kwargs)
        discovery.subprocess.run = run
        try:
            result = discovery.search(index, **params)
        finally:
            discovery.subprocess.run = original_run
    # Readers get immutable public indexes; only the trusted broker can write.
    for root, dirs, files in os.walk(cache, followlinks=False):
        os.chmod(root, 0o755)
        for name in files:
            path = Path(root) / name
            if not path.is_symlink():
                os.chmod(path, 0o644)
    return result


if __name__ == '__main__':
    versions = json.loads(Path(__file__).with_name('versions.json').read_text())
    cache = Path('/data/reference-cache') / versions['toolkit'] / '.cache'
    try:
        result = execute(json.loads(sys.stdin.buffer.read(65537)), cache)
        print(json.dumps({'result': result}, allow_nan=False))
    except Exception:
        # Provider errors may contain credentials. Never forward/log their text.
        print(json.dumps({'error': 'Shared reference search failed. Check runtime capacity and search provider configuration.'}))
        sys.exit(1)
