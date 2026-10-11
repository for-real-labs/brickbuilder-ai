"""Bounded retries for idempotent artifact uploads, never for AI requests."""
import asyncio
from asyncio import sleep as retry_sleep
import logging

import httpx

logger = logging.getLogger(__name__)


def _transient(exc: Exception) -> bool:
    if isinstance(exc, httpx.TransportError):
        return True
    response = getattr(exc, 'response', None)
    status = getattr(response, 'status_code', None) or getattr(exc, 'status', None)
    if isinstance(status, str) and status.isdigit():
        status = int(status)
    return status == 429 or isinstance(status, int) and 500 <= status < 600


async def upload_artifact(bucket, *, path: str, file: bytes, content_type: str):
    """Upsert the same bytes at the same path after temporary transport failures."""
    for attempt in range(4):
        try:
            return await asyncio.to_thread(bucket.upload, path=path, file=file,
                file_options={'content-type': content_type, 'upsert': 'true'})
        except Exception as exc:
            if attempt == 3 or not _transient(exc):
                raise
            logger.warning('Retrying artifact upload after %s (attempt %s/4)',
                           type(exc).__name__, attempt + 1)
            await retry_sleep(2 ** attempt)
