"""Reconcile verified email signups from Supabase into PostHog, including history."""
import asyncio
import logging
import os
from uuid import NAMESPACE_URL, uuid5

from posthog import Posthog

logger = logging.getLogger(__name__)
PAGE_SIZE = 100


def sync_verified_signups(client, analytics, delivered: set[str]) -> int:
    """Use confirmation time, never login time. Unique-user charts dedupe retries.

    Primary provider=email excludes Google signups, even if later linked to email.
    UUIDs are deterministic across restarts; no email or auth metadata is exported.
    """
    sent = 0
    page = 1
    while True:
        users = client.auth.admin.list_users(page=page, per_page=PAGE_SIZE)
        for user in users:
            if (user.is_anonymous or not user.email_confirmed_at
                    or (user.app_metadata or {}).get('provider') != 'email'):
                continue
            event_id = str(uuid5(NAMESPACE_URL, f'brickbuilder:verified-email-signup:v1:{user.id}'))
            if event_id in delivered:
                continue
            result = analytics.capture('verified_email_signup', distinct_id=str(user.id),
                uuid=event_id, timestamp=user.email_confirmed_at,
                properties={'service': 'brickai-api', 'environment': 'production',
                            'signup_method': 'email', 'metric_version': 1,
                            '$geoip_disable': True})
            if not result:
                raise RuntimeError('Signup event was not accepted')
            delivered.add(event_id)
            sent += 1
        if len(users) < PAGE_SIZE:
            return sent
        page += 1


async def verified_signup_worker(client):
    analytics = Posthog(project_api_key=os.environ['POSTHOG_API_KEY'],
                        host=os.getenv('POSTHOG_HOST', 'https://us.i.posthog.com'),
                        sync_mode=True, timeout=10, max_retries=2,
                        enable_exception_autocapture=False)
    delivered: set[str] = set()
    # Synchronous capture has no queue/consumer threads to flush on shutdown.
    while True:
        try:
            count = await asyncio.to_thread(sync_verified_signups, client, analytics, delivered)
            if count:
                logger.info('Synced %s verified email signup events', count)
        except Exception:
            logger.warning('Verified email signup sync failed; will retry')
        await asyncio.sleep(900)


def start_verified_signup_worker(client):
    # Preview environments can inherit production credentials. Never sync there.
    if (client and os.getenv('RAILWAY_ENVIRONMENT_NAME') == 'production'
            and os.getenv('POSTHOG_API_KEY')):
        return asyncio.create_task(verified_signup_worker(client))
    return None
