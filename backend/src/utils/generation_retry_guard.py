"""Public retry guidance for the database's provider-cost guard."""
import re
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime

from fastapi import HTTPException

RETRY_LIMIT_PREFIX = 'AI builds are paused after 3 failed or canceled attempts within 24 hours.'
RETRY_PENDING_MESSAGE = 'AI builds are temporarily paused while other builds finish. Please wait for a running build to finish before trying again. Your credits have not been charged for this request.'


def retry_guard_error(error: Exception) -> HTTPException | None:
    message = str(error)
    if 'BB_GENERATION_RETRY_PENDING' in message:
        return HTTPException(429, RETRY_PENDING_MESSAGE)
    if 'BB_GENERATION_RETRY_LIMIT' not in message:
        return None
    now = datetime.now(timezone.utc)
    reset_at = now + timedelta(hours=24)
    match = re.search(r'BB_GENERATION_RETRY_LIMIT:(\d{1,12})\b', message)
    if match:
        try:
            candidate = datetime.fromtimestamp(int(match[1]), timezone.utc)
            if now - timedelta(hours=24) <= candidate <= reset_at + timedelta(seconds=1):
                # A cooldown may expire while the response is in transit.
                reset_at = max(now, candidate)
        except (ValueError, OverflowError, OSError):
            pass
    return HTTPException(429,
        f'{RETRY_LIMIT_PREFIX} Please wait until {reset_at:%B %d, %Y at %H:%M} UTC to generate again. '
        'Your credits have not been charged for this request. Upgrading does not remove this pause.',
        headers={'Retry-After': format_datetime(reset_at, usegmt=True)})
