import asyncio
import importlib
import json
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

from src.utils import parts_catalog
from test_parts_catalog import CATALOG, PLACEMENT


def integration(monkeypatch):
    package = ModuleType('brickbuilder_integration')
    package.__path__ = [str(Path(__file__).parents[1] / 'nova-service')]
    monkeypatch.setitem(sys.modules, 'brickbuilder_integration', package)
    monkeypatch.setitem(sys.modules, 'brickbuilder_integration.parts_catalog', parts_catalog)
    monkeypatch.delitem(sys.modules, 'brickbuilder_integration.parts_restrictions', raising=False)
    return importlib.import_module('brickbuilder_integration.parts_restrictions')


def test_reference_changes_cannot_change_authoritative_policy(tmp_path, monkeypatch):
    module = integration(monkeypatch)
    monkeypatch.setitem(sys.modules, 'sandbox', SimpleNamespace(give_to_agent=lambda path: None))
    work = tmp_path / 'work'
    policy = module.ChatPartsPolicy(tmp_path / 'protected')
    store = SimpleNamespace(work_dir=lambda chat: work)
    policy.configure(store, 'chat', CATALOG)
    (work / 'allowed-parts.csv').write_text(CATALOG.replace('3001,4', '3001,0'))
    assert policy.load('chat').search('3001', 4)['total'] == 1
    assert policy.path('chat').stat().st_mode & 0o777 == 0o600
    assert policy.load('other') is None
    with pytest.raises(ValueError):
        policy.path('../other')
    (work / 'allowed-parts.csv').unlink()
    victim = tmp_path / 'keep'; victim.write_text('keep')
    (work / 'allowed-parts.csv').symlink_to(victim)
    policy.configure(store, 'chat', CATALOG)
    assert victim.read_text() == 'keep'


def hooks(tmp_path, monkeypatch):
    module = integration(monkeypatch)
    catalog = parts_catalog.PartsCatalog.from_csv(CATALOG)
    policy = SimpleNamespace(load=lambda chat: catalog)
    agent = SimpleNamespace(system_prompt=lambda store, chat: 'Original Nova instructions')
    calls = []
    async def run_command(*args, **kwargs): calls.append(args); return 'original command'
    class ToolError(Exception): pass
    tools = SimpleNamespace(run_command=run_command, ToolError=ToolError,
        ToolResult=lambda content: SimpleNamespace(content=content),
        resolve_path=lambda ctx, path, write: Path(path), TOOLS={}, TOOL_SCHEMAS=[],
        _fn=lambda name, description, properties, required: {'function': {'name': name}})
    module.install_parts_restrictions(agent, tools, SimpleNamespace(TOOLKIT_DIR=tmp_path, LDRAW_DIR=tmp_path), policy)
    ctx = SimpleNamespace(chat_id='chat', work_dir=tmp_path / 'output')
    return module, agent, tools, ctx, calls


def test_publication_is_blocked_before_upstream_can_publish(tmp_path, monkeypatch):
    module, agent, tools, ctx, calls = hooks(tmp_path, monkeypatch)
    assert 'MANDATORY PARTS POLICY' in agent.system_prompt(None, 'chat')
    assert {'list_allowed_parts', 'check_model_parts'} == set(tools.TOOLS)
    snapshot = ctx.work_dir / 'publication/revision/model.mpd'
    monkeypatch.setattr(module, 'expanded_inventory', lambda *args: {('3001', 0): 1})
    with pytest.raises(tools.ToolError, match='blocked publication'):
        asyncio.run(tools.run_command(ctx, ['./ldraw-agent', 'validate', str(snapshot), '--geometry'], 1800))
    assert not calls
    check = tools.TOOLS['check_model_parts'][1]
    model = tmp_path / 'model.mpd'; model.write_text(PLACEMENT)
    result = asyncio.run(check(ctx, str(model)))
    assert json.loads(result.content)['valid'] is False
    assert 'color 0' in json.loads(result.content)['error']
    monkeypatch.setattr(module, 'expanded_inventory', lambda *args: {('3001', 4): 1})
    assert asyncio.run(tools.run_command(ctx, ['./ldraw-agent', 'validate', str(snapshot), '--geometry'], 1800)) == 'original command'
    assert len(calls) == 1
    report = json.loads(asyncio.run(check(ctx, str(model))).content)
    assert report['physical_parts'] == 1 and report['parts_subtotal'] == '0.15'


def test_search_tool_enforces_pagination_bounds(tmp_path, monkeypatch):
    _, _, tools, ctx, _ = hooks(tmp_path, monkeypatch)
    search = tools.TOOLS['list_allowed_parts'][1]
    result = asyncio.run(search(ctx, '3001', 36, limit=1))
    assert json.loads(result.content)['parts'][0]['unit_price'] == '0.22'
    with pytest.raises(tools.ToolError):
        asyncio.run(search(ctx, limit=100000))
