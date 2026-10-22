from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pgserver
import psycopg
import pytest

from src.utils import anthropic_reconciliation as module

NOW = datetime(2026, 10, 22, 12, tzinfo=timezone.utc)


def page(rows, **extra):
    return {'data': [{'starting_at': '2026-10-21T00:00:00Z', 'results': rows}],
            'has_more': False, **extra}


def http_for(*pages):
    http = Mock()
    http.get.side_effect = [Mock(json=Mock(return_value=p)) for p in pages]
    return http


def test_pagination_workspace_scope_cents_and_idempotent_upsert():
    usage = {'workspace_id': 'ws', 'model': 'claude-opus', 'output_tokens': 100}
    cost = {'workspace_id': 'ws', 'amount': '123.456', 'currency': 'USD'}
    http = http_for(page([usage], has_more=True, next_page='next'), page([usage]), page([cost]))
    client = Mock()
    client.rpc.return_value.execute.return_value.data = [
        {'usage_day': '2026-10-21', 'estimated_claude_cost_usd': '0.5'}]
    assert module.reconcile(client, http, 'ws', NOW) == 7
    rows = client.table.return_value.upsert.call_args.args[0]
    assert rows[-1]['provider_cost_usd'] == '1.23456'
    assert rows[-1]['diagnostic_cost_gap_usd'] == '0.73456'
    assert len(rows[-1]['provider_usage']) == 2
    assert rows[-1]['provider_token_totals']['output_tokens'] == 200
    assert rows[-1]['diagnostic_token_gaps']['output_tokens'] == '200'
    assert rows[0]['provider_cost_usd'] is None
    assert rows[0]['provider_usage'] is None
    assert client.table.return_value.upsert.call_args.kwargs['on_conflict'] == 'workspace_id,usage_day'
    assert all(c.kwargs['params']['workspace_ids[]'] == 'ws' for c in http.get.call_args_list)


@pytest.mark.parametrize('bad', [
    page([{'workspace_id': 'other'}]),
    page([], has_more=True, next_page=None),
    {'data': [{'starting_at': '2025-01-01T00:00:00Z', 'results': []}], 'has_more': False},
])
def test_failed_fetch_never_writes_partial_snapshot(bad):
    client = Mock()
    with pytest.raises(ValueError):
        module.reconcile(client, http_for(bad), 'ws', NOW)
    client.table.assert_not_called()


def test_cost_failure_preserves_previous_snapshots():
    http = http_for(page([]), page([{'workspace_id': 'ws', 'amount': '1', 'currency': 'EUR'}]))
    client = Mock(); client.rpc.return_value.execute.return_value.data = []
    with pytest.raises(ValueError):
        module.reconcile(client, http, 'ws', NOW)
    client.table.assert_not_called()


@pytest.mark.parametrize('environment,key,workspace', [('preview','secret','ws'), ('production','','ws'), ('production','secret','')])
def test_worker_is_disabled_without_production_and_complete_credentials(monkeypatch, environment,key,workspace):
    monkeypatch.setenv('RAILWAY_ENVIRONMENT_NAME',environment)
    monkeypatch.setenv('ANTHROPIC_ADMIN_KEY',key)
    monkeypatch.setenv('ANTHROPIC_USAGE_WORKSPACE_ID',workspace)
    assert module.start_anthropic_reconciliation(Mock()) is None


def test_sql_summary_counts_each_job_once_and_excludes_other_providers(tmp_path):
    server = pgserver.get_server(tmp_path/'pg', cleanup_mode='delete')
    try:
        with psycopg.connect(server.get_uri(), autocommit=True) as conn:
            for role in ('anon','authenticated','service_role'):
                conn.execute(f'CREATE ROLE {role}')
            conn.execute('CREATE TABLE generations (created_at timestamptz, ai_usage jsonb)')
            conn.execute((Path(__file__).parents[2]/'supabase/migrations/20261022030000_anthropic_usage_reconciliation.sql').read_text())
            conn.execute('''INSERT INTO generations VALUES ('2026-10-21T10:00Z',
                '{"calls":[{"model":"claude-opus","estimated_cost_usd":"2","input_tokens":5,"output_tokens":9},
                {"model":"claude-haiku","estimated_cost_usd":"1","input_tokens":3,"output_tokens":4},
                {"model":"gpt","estimated_cost_usd":"10"}]}'), ('2026-10-21T11:00Z',null)''')
            row = conn.execute("SELECT * FROM anthropic_local_usage_summary('2026-10-21Z','2026-10-22Z')").fetchone()
            assert row[1:6] == (2,1,3,8,13)
            assert not conn.execute("SELECT has_table_privilege('authenticated','anthropic_daily_reconciliation','SELECT')").fetchone()[0]
            assert not conn.execute("SELECT has_function_privilege('anon','anthropic_local_usage_summary(timestamptz,timestamptz)','EXECUTE')").fetchone()[0]
    finally:
        server.cleanup()


def test_provider_input_total_includes_all_cache_tokens():
    assert module.token_totals([{'uncached_input_tokens': 2, 'output_tokens': 3,
        'cache_read_input_tokens': 5, 'cache_creation': {'ephemeral_5m_input_tokens': 7,
        'ephemeral_1h_input_tokens': 11}}]) == {'input_tokens':25,'output_tokens':3,
        'cache_read_input_tokens':5,'cache_creation_input_tokens':18}
