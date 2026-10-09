import asyncio
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parents[1] / 'nova-service' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


review = load('build_review')
flatten = load('flatten')


def edges(*pairs):
    return [{'instances': list(pair), 'status': 'confirmed'} for pair in pairs]


def test_later_bridge_does_not_clear_earlier_floating_step():
    result = review.review_connections([1, 2, 3], edges((0, 2), (1, 2)))
    assert result['final_component_count'] == 1
    assert result['failed_step_count'] == 1
    assert result['failures'][0]['step'] == 2


def test_parts_added_together_can_connect_through_the_same_step():
    result = review.review_connections([1, 2, 2, 2], edges((0, 3), (3, 2), (2, 1)))
    assert result['failed_step_count'] == 0


def test_first_step_and_finished_model_must_be_connected():
    result = review.review_connections([1, 1, 2], edges((0, 2)))
    assert result['final_component_count'] == 2
    assert [f['step'] for f in result['failures']] == [1, 2]
    assert review.review_connections([1], [])['failed_step_count'] == 0


def test_report_limits_never_clear_failures():
    result = review.review_connections(list(range(1, 151)), [])
    assert result['failed_step_count'] == 149
    assert len(result['failures']) == review.MAX_DIAGNOSTICS
    assert result['failures_truncated'] is True


@pytest.mark.parametrize('steps,contacts', [([], []), ([2], []), ([1, 3], []),
    ([1, 2, 1], []), ([1], edges((0, 1))), ([1], [{'instances': [0, 0], 'status': 'unknown'}])])
def test_incomplete_graphs_fail_closed(steps, contacts):
    with pytest.raises(ValueError):
        review.review_connections(steps, contacts)


def test_potential_connections_keep_the_toolkits_evidence_semantics():
    assert review.review_connections([1, 2], [{'instances': [0, 1], 'status': 'potential'}])['failed_step_count'] == 0


def test_exported_steps_distinguish_repeated_nested_subassemblies():
    root, child = SimpleNamespace(steps=[1, 2]), SimpleNamespace(steps=[1, 2])
    first, second = object(), object()
    def occurrence(piece, local_step):
        return SimpleNamespace(path=[SimpleNamespace(model=root, local_step=0, piece=piece),
                                     SimpleNamespace(model=child, local_step=local_step)])
    assert flatten.instruction_steps([occurrence(first, 0), occurrence(first, 1),
                                      occurrence(second, 0), occurrence(second, 1)]) == [1, 2, 3, 4]
    child.steps = [1]
    assert flatten.instruction_steps([occurrence(first, 0), occurrence(second, 0)]) == [1, 1]


@pytest.mark.parametrize('passed', [False, True])
def test_publication_reviews_a_snapshot_and_reports_failures_without_storing(tmp_path, monkeypatch, passed):
    policy = load('build_policy')
    source = tmp_path / 'guitar.mpd'
    source.write_bytes(b'original model')
    original = AsyncMock(return_value='published')
    schema = {'function': {'description': 'Publish'}}
    tools = SimpleNamespace(TOOLS={'publish_model': (schema, original)},
                            resolve_path=lambda *args, **kwargs: source,
                            ToolResult=lambda content: SimpleNamespace(content=content), ToolError=ValueError)
    def run(content, library):
        assert content == b'original model'
        source.write_bytes(b'changed during review')
        return {'passed': passed, 'diagnostics': [], 'instructions': {'checked': True}}, {}
    monkeypatch.setattr(policy, 'review_source', run)
    policy.install_build_policy(tools, SimpleNamespace(LDRAW_DIR=tmp_path))
    policy.install_build_policy(tools, SimpleNamespace(LDRAW_DIR=tmp_path))
    result = asyncio.run(tools.TOOLS['publish_model'][1](SimpleNamespace(work_dir=tmp_path, emit=lambda *args: None), str(source)))
    if passed:
        assert result == 'published'
        snapshot = Path(original.call_args.args[1])
        assert snapshot.read_bytes() == b'original model'
        assert original.call_args.args[2] == 'guitar'
    else:
        original.assert_not_awaited()
        assert 'Repair disconnected' in json.loads(result.content)['error']
    assert list(tmp_path.glob('build-review-*/build-review.json'))


def test_review_executes_immutable_toolkit_as_separate_user_without_secrets(tmp_path, monkeypatch):
    policy = load('build_policy')
    monkeypatch.setattr(policy.pwd, 'getpwnam', lambda name: SimpleNamespace(pw_uid=123, pw_gid=456))
    monkeypatch.setattr(policy.os, 'chown', lambda *args: None)
    monkeypatch.setenv('OPENAI_API_KEY', 'must-not-be-forwarded')
    def run(command, **kwargs):
        assert command[0] == '/opt/ldraw-nova/.venv/bin/python'
        assert kwargs['user'] == 123 and kwargs['group'] == 456 and kwargs['extra_groups'] == []
        assert 'OPENAI_API_KEY' not in kwargs['env']
        assert kwargs['env']['PYTHONPATH'] == '/opt/ldraw-nova'
        root = Path(command[-1])
        assert (root / 'model.mpd').read_bytes() == b'model'
        (root / 'build-review.json').write_text(json.dumps({'version': 1, 'passed': False}))
    monkeypatch.setattr(policy.subprocess, 'run', run)
    result, artifacts = policy.review_source(b'model', tmp_path)
    assert result['passed'] is False and artifacts == {}


@pytest.mark.parametrize('fault', ['none', 'skipped', 'truncated', 'incomplete', 'collision', 'wrong_count', 'late_error'])
def test_review_requires_complete_geometry_and_full_contacts(tmp_path, monkeypatch, fault):
    import sys
    source = tmp_path / 'model.mpd'
    source.write_bytes(b'model')
    geometry = {'complete': fault != 'incomplete', 'occurrence_count': 501,
                'contacts_checked': fault != 'skipped', 'contact_count': 500,
                'contacts_truncated': fault == 'truncated', 'instances_truncated': False,
                'confirmed_component_count': 1, 'optimistic_component_count': 1,
                'connection_coverage': {'complete': 501},
                'contacts': edges(*[(i, i + 1) for i in range(500)]), 'instances': [],
                'diagnostics': ([{'severity': 'warning', 'code': 'header.missing'}] * 150
                                + [{'severity': 'error', 'code': 'assembly.body_overlap'}]) if fault == 'late_error'
                                else [{'severity': 'error', 'code': 'assembly.body_overlap'}] if fault == 'collision' else []}
    if fault == 'wrong_count': geometry['contact_count'] += 1
    def analyze(*args, **kwargs):
        assert kwargs['contacts'] == 'all'
        return geometry
    common, document = SimpleNamespace(get_parts=lambda library: None), SimpleNamespace(physical_context=lambda *args: (None, None))
    monkeypatch.setitem(sys.modules, 'ldraw_tools', SimpleNamespace(common=common, document=document))
    monkeypatch.setitem(sys.modules, 'ldraw_tools.common', common)
    monkeypatch.setitem(sys.modules, 'ldraw_tools.document', document)
    monkeypatch.setitem(sys.modules, 'ldraw_tools.validation', SimpleNamespace(validate_file=lambda *args, **kwargs: (object(), [])))
    monkeypatch.setitem(sys.modules, 'ldraw_tools.geometry', SimpleNamespace(analyze_geometry=analyze))
    monkeypatch.setitem(sys.modules, 'flatten', SimpleNamespace(MAX_INSTANCES=100000,
        physical_occurrences=lambda *args: list(range(501)), instruction_steps=lambda *args: [1] * 501,
        serialize_placements=lambda *args, **kwargs: 'reviewed placements'))
    result = review.review_model(source, tmp_path, tmp_path)
    assert result['passed'] is (fault == 'none')
    if fault == 'late_error':
        assert result['diagnostics_truncated'] is True
        assert result['diagnostics'][0]['code'] == 'assembly.body_overlap'
