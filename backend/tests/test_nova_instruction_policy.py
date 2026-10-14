import asyncio
import importlib.util
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

spec = importlib.util.spec_from_file_location('instruction_policy', Path(__file__).parents[1] / 'nova-service/instruction_policy.py')
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class ToolError(Exception):
    pass


def publishing(tmp_path):
    source = tmp_path / 'draft.mpd'
    source.write_text('captured model')
    publisher = AsyncMock(side_effect=lambda ctx, path, name: Path(path).read_text())
    tools = SimpleNamespace(TOOLS={'publish_model': ({'function': {'description': 'Publish'}}, publisher)},
        resolve_path=lambda ctx, path, **kwargs: Path(path), ToolError=ToolError,
        ToolResult=lambda content: SimpleNamespace(content=content))
    ctx = SimpleNamespace(work_dir=tmp_path, emit=lambda *args: None)
    settings = SimpleNamespace(TOOLKIT_DIR=tmp_path, LDRAW_DIR=tmp_path)
    policy.install_instruction_policy(tools, settings)
    return source, publisher, tools, ctx


def test_disconnected_publication_returns_repair_locations_to_agent(tmp_path, monkeypatch):
    source, publisher, tools, ctx = publishing(tmp_path)
    report = {'passed': False, 'error': 'Disconnected parts', 'remaining_count': 24,
              'remaining_parts': [{'occurrence': 482, 'part': '65429', 'position': [21, -24, 161]}]}
    monkeypatch.setattr(policy, 'review_instructions', lambda *args: report)
    result = asyncio.run(tools.t_publish_model(ctx, str(source)))
    feedback = json.loads(result.content)
    assert feedback['remaining_parts'] == report['remaining_parts']
    assert feedback['remaining_count'] == 24 and feedback['reason'] == 'Disconnected parts'
    assert 'Publication blocked' in feedback['error']
    publisher.assert_not_awaited()


def test_publication_uses_the_checked_revision_when_working_source_changes(tmp_path, monkeypatch):
    source, publisher, tools, ctx = publishing(tmp_path)
    def review(content, *args):
        assert content == b'captured model'
        assert args[0] == policy.TOOLKIT_ROOT
        source.write_text('changed during review')
        return {'passed': True}
    monkeypatch.setattr(policy, 'review_instructions', review)
    assert asyncio.run(tools.t_publish_model(ctx, str(source))) == 'captured model'
    assert publisher.await_args.args[2] == 'draft'
    snapshot = Path(publisher.await_args.args[1])
    assert snapshot.stat().st_mode & 0o222 == 0


@pytest.mark.parametrize('error', [OSError('private config path'), ValueError('invalid report'), subprocess.TimeoutExpired('check', 1800)])
def test_unfinished_instruction_review_never_publishes(tmp_path, monkeypatch, error):
    source, publisher, tools, ctx = publishing(tmp_path)
    def review(*args):
        raise error
    monkeypatch.setattr(policy, 'review_instructions', review)
    with pytest.raises(ToolError, match='Publication is blocked'):
        asyncio.run(tools.t_publish_model(ctx, str(source)))
    publisher.assert_not_awaited()


@pytest.mark.parametrize('disconnected', [False, True])
def test_review_runs_exact_snapshot_unprivileged_and_requires_export(tmp_path, monkeypatch, disconnected):
    monkeypatch.setattr(policy.pwd, 'getpwnam', lambda name: SimpleNamespace(pw_uid=65534, pw_gid=65534))
    monkeypatch.setattr(policy.os, 'chown', lambda *args: None)
    def run(args, **kwargs):
        assert Path(args[2]).read_bytes() == b'original MPD'
        assert args[-1] == '--instructions'
        assert kwargs['user'] == 65534 and kwargs['extra_groups'] == []
        assert kwargs['env']['PYTHONPATH'] == str(tmp_path)
        output = Path(args[3])
        if disconnected:
            output.with_suffix('.error').write_text('Fixed API feedback')
            output.with_suffix('.review.json').write_text(json.dumps({'remaining_count': 24}))
            raise subprocess.CalledProcessError(1, args)
        output.write_text('verified connected placements')
    monkeypatch.setattr(policy.subprocess, 'run', run)
    report = policy.review_instructions(b'original MPD', tmp_path, tmp_path)
    assert report['passed'] is (not disconnected)
    if disconnected:
        assert report['remaining_count'] == 24


def test_tool_installation_does_not_wrap_publication_twice(tmp_path):
    _, _, tools, _ = publishing(tmp_path)
    original = tools.t_publish_model
    policy.install_instruction_policy(tools, SimpleNamespace())
    assert tools.t_publish_model is original
