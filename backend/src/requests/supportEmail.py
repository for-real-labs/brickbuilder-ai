"""Send support mail with server-verified identity and model context."""
import asyncio
import hashlib
import logging
import os
from urllib.parse import urlencode
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, EmailStr, Field

from ..utils.auth import get_optional_identity, get_anonymous_user_id, check_anonymous_short_window_limit
from ..utils.authorization import require_generation_access
from ..utils.generation_email import notification_origin, sender
from ..utils.generation_storage import generation_storage

router = APIRouter()
logger = logging.getLogger(__name__)
SUPPORT_EMAIL = 'support@brickbuilder.ai'
SEND_ERROR = 'Could not send. Try again or email support@brickbuilder.ai.'


class SupportEmailRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra='forbid')
    email: EmailStr = Field(max_length=254)
    message: str = Field(min_length=1, max_length=5000)
    generation_id: UUID | None = None
    request_id: UUID


async def support_generations(request: SupportEmailRequest, identity: dict) -> list[dict]:
    if not generation_storage:
        return []
    if request.generation_id:
        try:
            row = await generation_storage.get_generation(str(request.generation_id))
            if row:
                require_generation_access(row, identity, allow_community=True)
                return [row]
        except HTTPException:
            pass  # Do not reveal whether a private model exists.
        except Exception:
            logger.warning('Support model lookup unavailable')
    if not identity.get('user_id'):
        return []
    try:
        rows = await generation_storage.get_user_generations(
            user_id=identity['user_id'],
            user_type='authenticated' if identity.get('authenticated') else 'anonymous',
            limit=3, include_details=False,
        )
        # Keep the authorization boundary even if a storage adapter changes.
        result = []
        for row in rows[:3]:
            require_generation_access(row, identity)
            result.append(row)
        return result
    except Exception:
        logger.warning('Support recent models unavailable')
        return []


def support_payload(request: SupportEmailRequest, identity: dict, generations: list[dict]) -> dict:
    context = [f"User ID: {identity.get('user_id') or 'Unavailable'}",
               f"Account: {'Signed in' if identity.get('authenticated') else 'Guest'}"]
    if not generations:
        context.append('Generations: None available')
    for row in generations:
        generation_id = str(row['id'])
        link = notification_origin().rstrip('/') + '/?' + urlencode({'id': generation_id, 'exact': '1'})
        name = ' '.join(str(row.get('name') or 'Untitled model').split())[:200]
        context.append(f"\nGeneration: {generation_id}\nName: {name}\nStatus: {row.get('status', 'unknown')}\n{link}")
    return {
        'from': os.getenv('SUPPORT_EMAIL_FROM') or sender(),
        'to': [SUPPORT_EMAIL], 'reply_to': str(request.email),
        'subject': 'BrickBuilder support',
        'text': f"From: {request.email}\n\n{request.message}\n\n--- Support context ---\n" + '\n'.join(context),
    }


async def send_support_email(request: SupportEmailRequest, identity: dict, transport=None):
    if not os.getenv('RESEND_API_KEY') or not (os.getenv('SUPPORT_EMAIL_FROM') or sender()):
        raise HTTPException(503, SEND_ERROR)
    try:
        generations = await asyncio.wait_for(support_generations(request, identity), timeout=5)
    except asyncio.TimeoutError:
        generations = []  # Model context should never prevent asking for help.
    payload = support_payload(request, identity, generations)
    key = hashlib.sha256(f"{identity.get('user_id', '')}:{request.request_id}".encode()).hexdigest()
    try:
        async with httpx.AsyncClient(transport=transport, timeout=15) as client:
            response = await client.post('https://api.resend.com/emails', json=payload, headers={
                'Authorization': 'Bearer ' + os.environ['RESEND_API_KEY'],
                'Idempotency-Key': 'support/' + key,
            })
        if not response.is_success or not response.json().get('id'):
            raise HTTPException(503, SEND_ERROR)
    except (httpx.HTTPError, ValueError, AttributeError):
        raise HTTPException(503, SEND_ERROR) from None
    return {'sent': True}


@router.post('/support-email')
async def support_email(request: SupportEmailRequest, http_request: Request,
                        identity: dict = Depends(get_optional_identity)):
    # Bound both account and anonymous traffic; rotating guest tokens cannot bypass the IP limit.
    check_anonymous_short_window_limit('support-ip:' + get_anonymous_user_id(http_request))
    if identity.get('user_id'):
        check_anonymous_short_window_limit('support-user:' + identity['user_id'])
    return await send_support_email(request, identity)
