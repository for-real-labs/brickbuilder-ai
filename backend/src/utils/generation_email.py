"""Durable opt-in completion emails; no campaign enrollment or client secrets."""
import asyncio
import html
import logging
import os
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import httpx

logger = logging.getLogger(__name__)


def notification_origin():
    configured = os.getenv('GENERATION_NOTIFICATION_ORIGIN')
    if configured:
        return configured.rstrip('/')
    if os.getenv('RAILWAY_ENVIRONMENT_NAME') == 'staging':
        return 'https://brickbuilderai-git-staging-jjohnson3700team.vercel.app'
    return 'https://brickbuilder.ai'


def sender():
    # Dedicated authenticated notification sender; never silently fall back to marketing.
    return os.getenv('GENERATION_NOTIFICATION_FROM')


def email_payload(row):
    title = ' '.join(row['title'].split())[:120] or 'Your brick model'
    url = row['origin'] + '/generated-model?' + urlencode({'id': row['generation_id'], 'exact': '1'})
    return {'from': sender(), 'to': [row['email']], 'reply_to': 'support@brickbuilder.ai',
            'subject': f'{title} is ready!',
            'text': f'{title} is ready!\n\nSee your model: {url}\n\nYou asked for this one email on BrickBuilder. No more reminders.',
            'html': f'<p><strong>{html.escape(title)} is ready!</strong></p><p><a href="{html.escape(url, quote=True)}">See your model</a></p><p>You asked for this one email on BrickBuilder. No more reminders.</p>'}


async def deliver_one(client, transport=None):
    row = await asyncio.to_thread(lambda: client.rpc('claim_generation_email', {'p_origin': notification_origin()}).execute())
    if not row.data:
        return False
    row = row.data[0]
    try:
        async with httpx.AsyncClient(transport=transport, timeout=20) as http:
            response = await http.post('https://api.resend.com/emails', json=email_payload(row),
                headers={'Authorization': 'Bearer ' + os.environ['RESEND_API_KEY'],
                         'Idempotency-Key': 'generation-ready/' + row['generation_id']})
        if response.is_success and response.json().get('id'):
            update = {'state': 'sent', 'sent_at': datetime.now(timezone.utc).isoformat(), 'provider_id': response.json()['id']}
        elif response.status_code in (408,429) or response.status_code >= 500:
            update = {'state': 'pending', 'available_at': (datetime.now(timezone.utc) + timedelta(seconds=min(3600, 60 * 2 ** row['attempts']))).isoformat()}
        else:
            # Suppressions, invalid recipients and permanent provider errors are never retried.
            update = {'state': 'failed'}
    except (httpx.HTTPError, ValueError):
        update = {'state': 'pending', 'available_at': (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()}
    if update['state'] == 'pending' and row['attempts'] >= 6:
        update = {'state': 'failed'}
    await asyncio.to_thread(lambda: client.table('generation_email_outbox').update(update)
                            .eq('generation_id', row['generation_id']).eq('lease_id', row['lease_id']).execute())
    return True


async def email_worker(client):
    while True:
        try:
            if not await deliver_one(client):
                await asyncio.sleep(15)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning('Completion email delivery unavailable; retrying without affecting generations')
            await asyncio.sleep(30)


def start_email_worker(client):
    enabled = os.getenv('GENERATION_NOTIFICATION_WORKER', 'true' if os.getenv('RAILWAY_ENVIRONMENT_NAME') else 'false') == 'true'
    if client and enabled and sender() and os.getenv('RESEND_API_KEY'):
        return asyncio.create_task(email_worker(client))
    return None
