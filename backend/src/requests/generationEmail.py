import asyncio
import os
from uuid import UUID

from fastapi import HTTPException
from pydantic import BaseModel, EmailStr

from ..utils.authorization import require_generation_access
from ..utils.generation_storage import generation_storage
from ..utils.generation_email import notification_origin, sender


class NotificationEmailRequest(BaseModel):
    email: EmailStr | None = None


async def notification_row(generation_id, auth_info):
    row = await generation_storage.get_generation(generation_id) if generation_storage else None
    if not row:
        raise HTTPException(404, 'Generation not found')
    require_generation_access(row, auth_info)
    return row


async def notification_status(generation_id, auth_info):
    row = await notification_row(generation_id, auth_info)
    return {'subscribed': bool(row.get('notification_email'))}


async def save_notification_email(generation_id, request, auth_info):
    row = await notification_row(generation_id, auth_info)
    if not sender() or not os.getenv('RESEND_API_KEY'):
        raise HTTPException(503, 'Email notifications are not ready yet. Please try again later.')
    if row['status'] in ('failed', 'cancelled'):
        raise HTTPException(409, 'This build has stopped. Start or resume it first.')
    email = row.get('notification_email') or (auth_info.get('user_email') if auth_info.get('authenticated') else request.email)
    if not email:
        raise HTTPException(422, 'Enter your email address.')
    email = str(NotificationEmailRequest(email=email).email).lower()
    client = generation_storage.client
    try:
        result = await asyncio.to_thread(lambda: client.rpc('subscribe_generation_email', {
            'p_id': generation_id, 'p_email': email, 'p_origin': notification_origin()}).execute())
    except Exception as error:
        if 'notification recipient limit' in str(error):
            raise HTTPException(429, 'You can request up to 3 build emails a day.') from None
        raise HTTPException(503, 'Could not save your notification. Please try again.') from None
    if not result.data:
        raise HTTPException(409, 'This build has stopped. Start or resume it first.')
    email = (await generation_storage.get_generation(generation_id))['notification_email']
    # Existing accounts are preserved. New guest contacts are unverified Auth
    # users (no login/OTP email sent), satisfying user_profiles' Auth foreign key.
    if not auth_info.get('authenticated'):
        profile = await asyncio.to_thread(lambda: client.rpc('notification_profile_id', {'p_email': email}).execute())
        profile_id = profile.data
        if not profile_id:
            try:
                user = await asyncio.to_thread(lambda: client.auth.admin.create_user({'email': email, 'email_confirm': False}))
                profile_id = user.user.id
            except Exception:
                profile_id = (await asyncio.to_thread(lambda: client.rpc('notification_profile_id', {'p_email': email}).execute())).data
                if not profile_id:
                    raise HTTPException(503, 'Could not save your email. Please try again.') from None
        await asyncio.to_thread(lambda: client.table('user_profiles').upsert({'id': str(UUID(profile_id)), 'email': email}, on_conflict='id', ignore_duplicates=True).execute())
    return {'subscribed': True}
