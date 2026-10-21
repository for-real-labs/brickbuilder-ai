"""Minimal server-side telemetry for rejected generation admissions only."""
import logging
import os
from functools import lru_cache

from posthog import Posthog

logger = logging.getLogger(__name__)
LIMITS = {
    'BB_GENERATION_GUEST_LIMIT': ('guest_lifetime', 3, 403),
    'BB_GENERATION_DAILY_LIMIT': ('daily', 30, 429),
    'BB_GENERATION_CONCURRENCY_LIMIT': ('concurrent', 5, 429),
}


@lru_cache(maxsize=1)
def _client():
    key = os.getenv('POSTHOG_API_KEY')
    if not key:
        return None
    return Posthog(project_api_key=key, host=os.getenv('POSTHOG_HOST', 'https://us.i.posthog.com'),
                   enable_exception_autocapture=False)


def track_request_limit(error: Exception, *, user_id: str, user_type: str, endpoint: str):
    """One event per rejected admission, never prompts, email, IP or network hashes.

    Separate from legacy tracking (which is disabled) to avoid enabling unrelated
    payloads. Analytics failures must not alter the response or admit a request.
    """
    limit = next((value for code, value in LIMITS.items() if code in str(error)), None)
    if limit is None:
        return
    try:
        client = _client()
        if client is None:
            return
        kind, value, status = limit
        client.capture(distinct_id=user_id, event='request_limit_hit', properties={
            'service': 'brickai-api',
            'environment': os.getenv('RAILWAY_ENVIRONMENT_NAME') or os.getenv('ENVIRONMENT', 'development'),
            'limit_type': kind, 'limit_value': value, 'http_status': status,
            'user_type': user_type, 'endpoint': endpoint,
            'metric_version': 1, '$geoip_disable': True,
        })
    except Exception:
        logger.warning('Request-limit analytics could not be queued')


def shutdown_request_limit_analytics():
    if not _client.cache_info().currsize:
        return
    try:
        client = _client()
        if client is not None:
            client.shutdown()
    except Exception:
        logger.warning('Request-limit analytics could not be flushed')
    finally:
        _client.cache_clear()
