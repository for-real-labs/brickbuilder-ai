import importlib.util
import json
from pathlib import Path
from types import ModuleType, SimpleNamespace
import sys

import pytest


def load(name):
    path = Path(__file__).parents[1] / 'nova-service' / (name + '.py')
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize('body', [
    {'action': 'search', 'params': {'kind': 'parts', 'query': 'brick', 'database': '/config/secret'}},
    {'action': 'index', 'params': {'root': '/data/tenants/private'}},
    {'action': 'search', 'params': {'kind': 'parts', 'query': 'brick', 'candidates': -1}},
    {'action': 'search', 'params': {'kind': 'parts', 'query': 'brick', 'pool': 1000000}},
    {'action': 'search', 'params': {'kind': 'parts', 'query': 'brick', 'timeout': 1000}},
    {'action': 'inventory', 'params': {'id': '../../private', 'max_instances': 100}},
    {'action': 'execute', 'params': {'command': 'cat /config/secret'}},
])
def test_shared_broker_rejects_paths_commands_and_unbounded_work(body):
    with pytest.raises(ValueError):
        load('shared_reference').validate(body)


def test_shared_indexes_use_one_directory_and_never_store_private_scores(tmp_path, monkeypatch):
    module = load('shared_reference')
    package = ModuleType('ldraw_tools')
    common = SimpleNamespace(get_parts=lambda: SimpleNamespace(path=tmp_path / 'parts.lst'))
    resources = SimpleNamespace()
    calls = []
    class Index:
        def __init__(self, parts):
            self.cache = discovery.CACHE / 'discovery'
            self.cache.mkdir(parents=True, exist_ok=True)
        def ensure(self):
            (self.cache / 'catalog.sqlite').write_text('public reference metadata')
            return {'index': str(self.cache / 'catalog.sqlite')}
    def search(index, **params):
        discovery.subprocess.run(['jev-rerank', '--db', str(index.cache / 'queries' / ('a' * 64 + '.sqlite')), '--query', params['query']])
        return {'results': [], 'query': params['query']}
    discovery = SimpleNamespace(DiscoveryIndex=Index, search=search,
        subprocess=SimpleNamespace(run=lambda cmd, **kwargs: calls.append(cmd)))
    package.common, package.discovery, package.resources = common, discovery, resources
    monkeypatch.setitem(sys.modules, 'ldraw_tools', package)
    monkeypatch.setenv('TYPESAFE_API_KEY', 'must-not-inherit-provider-secret')
    cache = tmp_path / 'shared' / '.cache'
    first = module.execute({'action': 'index'}, cache)
    second = module.execute({'action': 'index'}, cache)
    assert first['cache'] == second['cache']
    assert len(list(cache.rglob('catalog.sqlite'))) == 1
    assert (cache / 'discovery/catalog.sqlite').stat().st_mode & 0o222 == 0o200
    module.execute({'action': 'search', 'params': {'kind': 'parts', 'query': 'private query'}}, cache)
    assert calls[0][-3:] == ['--no-score-cache', '--cache-dir', str(cache / 'jev-rerank' / ('a' * 64))]
    assert 'TYPESAFE_API_KEY' not in module.os.environ
    assert all('private query' not in p.read_text() for p in cache.rglob('*') if p.is_file())


def test_tenants_read_same_reference_index_but_custom_indexes_remain_private(monkeypatch):
    client = load('reference_client')
    shared = '/data/reference-cache/' + 'a' * 40 + '/.cache/discovery/catalog'
    requests = []
    def request(action, params=None):
        requests.append((action, params))
        return {'cache': shared, 'report': {'index': shared + '/catalog.sqlite'}}
    monkeypatch.setattr(client, 'request', request)
    class Index:
        def __init__(self, parts, root=None, *, database=None, cache=None):
            self.cache = cache or 'private'
        def ensure(self, *, force=False):
            return {'private': True}
        def inventory(self, row, *, max_instances=100000):
            return {'private': True}
    discovery = SimpleNamespace(DiscoveryIndex=Index, search=lambda *args, **kwargs: {'private': True})
    client.install_discovery(discovery)
    first = Index(SimpleNamespace(path='/data/reference-cache/shared-parts.lst'))
    second = Index(SimpleNamespace(path='/data/reference-cache/shared-parts.lst'))
    assert first.cache == second.cache == shared
    assert first.ensure() == second.ensure() == {'index': shared + '/catalog.sqlite'}
    private = Index(SimpleNamespace(path='/data/tenants/private/parts.lst'))
    custom = Index(SimpleNamespace(path='/data/reference-cache/shared-parts.lst'), root='/private/models')
    assert private.ensure() == custom.ensure() == {'private': True}
    assert discovery.search(custom, 'models', 'private model') == {'private': True}


def test_owner_result_cache_rebuilds_after_eviction(tmp_path, monkeypatch):
    client = load('reference_client')
    common = ModuleType('reference_client.common')
    common.CACHE = tmp_path / 'private-cache'
    def atomic_write(path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    common.atomic_write = atomic_write
    monkeypatch.setitem(sys.modules, 'reference_client.common', common)
    client.__package__ = 'reference_client'
    calls = []
    def request(action, params=None):
        calls.append(action)
        return {'query': params['query'], 'results': []} if action == 'search' else {'cache': 'shared'}
    monkeypatch.setattr(client, 'request', request)
    class Index:
        def __init__(self, *args, **kwargs):
            pass
        def ensure(self, **kwargs):
            pass
        def inventory(self, *args, **kwargs):
            pass
    discovery = SimpleNamespace(DiscoveryIndex=Index, search=lambda *args: None)
    client.install_discovery(discovery)
    index = Index(SimpleNamespace(path='/data/reference-cache/shared-parts.lst'))
    result = discovery.search(index, 'parts', 'guitar neck')
    assert discovery.search(index, 'parts', 'guitar neck') == result
    assert calls.count('search') == 1
    for file in common.CACHE.glob('reference-search/*.json'):
        file.unlink()
    assert discovery.search(index, 'parts', 'guitar neck') == result
    assert calls.count('search') == 2
