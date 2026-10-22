"""Workspace-scoped billing checks; never distribute aggregate gaps to jobs."""
import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import httpx

logger = logging.getLogger(__name__)
BASE_URL = 'https://api.anthropic.com/v1/organizations/'


def read_report(http, kind, start, end, workspace):
    params = {'starting_at': start.isoformat(), 'ending_at': end.isoformat(),
              'bucket_width': '1d', 'limit': 31, 'workspace_ids[]': workspace,
              'group_by[]': ['workspace_id', 'model', 'speed'] if kind == 'usage_report/messages'
              else ['workspace_id', 'description']}
    buckets, seen = {}, set()
    for _ in range(100):
        response = http.get(BASE_URL + kind, params=params)
        response.raise_for_status()
        payload = response.json()
        for bucket in payload['data']:
            timestamp = datetime.fromisoformat(bucket['starting_at'].replace('Z', '+00:00'))
            if not start <= timestamp < end:
                raise ValueError('Report bucket outside requested window')
            rows = bucket['results']
            if any(row.get('workspace_id') != workspace for row in rows):
                raise ValueError('Report workspace mismatch')
            buckets.setdefault(timestamp.date().isoformat(), []).extend(rows)
        if payload.get('has_more') is False:
            return buckets
        page = payload.get('next_page')
        if not page or page in seen:
            raise ValueError('Invalid report pagination')
        seen.add(page)
        params['page'] = page
    raise ValueError('Report pagination limit exceeded')


def token_totals(rows):
    if rows is None:
        return None
    totals = dict.fromkeys(('input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'), 0)
    for row in rows:
        cache = row.get('cache_creation') or {}
        read = int(row.get('cache_read_input_tokens', 0))
        write = int(cache.get('ephemeral_5m_input_tokens', 0)) + int(cache.get('ephemeral_1h_input_tokens', 0))
        totals['input_tokens'] += int(row.get('uncached_input_tokens', 0)) + read + write
        totals['output_tokens'] += int(row.get('output_tokens', 0))
        totals['cache_read_input_tokens'] += read
        totals['cache_creation_input_tokens'] += write
    return totals


def reconcile(client, http, workspace, now=None):
    now = now or datetime.now(timezone.utc)
    # Revisit seven complete UTC days to pick up delayed billing and recovered jobs.
    end = now.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    start = end - timedelta(days=7)
    usage = read_report(http, 'usage_report/messages', start, end, workspace)
    costs = read_report(http, 'cost_report', start, end, workspace)
    local = {row['usage_day']: row for row in client.rpc('anthropic_local_usage_summary', {
        'start_at': start.isoformat(), 'end_at': end.isoformat()}).execute().data}
    records = []
    for offset in range(7):
        day = (start + timedelta(days=offset)).date().isoformat()
        # Missing buckets are unknown, never silently converted to zero billing.
        cost_rows = costs.get(day)
        amount = None
        if cost_rows is not None:
            if any(row.get('currency') != 'USD' for row in cost_rows):
                raise ValueError('Unexpected billing currency')
            amount = sum((Decimal(row['amount']) / 100 for row in cost_rows), Decimal(0))
            if not amount.is_finite():
                raise ValueError('Invalid billing amount')
        snapshot = local.get(day, {})
        local_cost = Decimal(str(snapshot.get('estimated_claude_cost_usd', 0)))
        tokens = token_totals(usage.get(day))
        gaps = {k: str(Decimal(v) - Decimal(str(snapshot.get(k, 0)))) for k, v in tokens.items()} if tokens is not None else None
        records.append({'workspace_id': workspace, 'usage_day': day,
            'observed_at': now.isoformat(), 'provider_usage': usage.get(day),
            'provider_cost_items': cost_rows, 'provider_token_totals': tokens,
            'diagnostic_token_gaps': gaps,
            'provider_cost_usd': str(amount) if amount is not None else None,
            'local_usage': snapshot,
            'diagnostic_cost_gap_usd': str(amount - local_cost) if amount is not None else None,
            'comparison_basis': 'workspace_billing_vs_generation_creation_day_not_exact_attribution'})
    client.table('anthropic_daily_reconciliation').upsert(
        records, on_conflict='workspace_id,usage_day').execute()
    return len(records)


async def reconciliation_worker(client, key, workspace):
    while True:
        try:
            def run():
                with httpx.Client(headers={'x-api-key': key, 'anthropic-version': '2023-06-01'},
                                  timeout=30, follow_redirects=False) as http:
                    return reconcile(client, http, workspace)
            count = await asyncio.to_thread(run)
            logger.info('Anthropic reconciliation refreshed %s daily snapshots', count)
        except Exception:
            # Do not log HTTP headers, admin credentials, or provider response bodies.
            logger.warning('Anthropic reconciliation failed; existing snapshots retained; retrying in one hour')
        await asyncio.sleep(3600)


def start_anthropic_reconciliation(client):
    if not client or os.getenv('RAILWAY_ENVIRONMENT_NAME') != 'production':
        return None
    key = os.getenv('ANTHROPIC_ADMIN_KEY')
    workspace = os.getenv('ANTHROPIC_USAGE_WORKSPACE_ID')
    if not key or not workspace:
        logger.warning('Anthropic reconciliation inactive: admin key and workspace configuration required')
        return None
    return asyncio.create_task(reconciliation_worker(client, key, workspace))
