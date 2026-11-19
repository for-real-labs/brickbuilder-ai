"""Retain only the encrypted Apple token needed for account deletion."""
import os

import httpx
import jwt
from cryptography.fernet import Fernet
from fastapi import HTTPException

from .database import execute_query

APPLE_ISSUER = 'https://appleid.apple.com'
TABLE = 'apple_sign_in_credentials'


def _credentials():
    client_id = os.environ['APPLE_SIGN_IN_CLIENT_ID']
    return {
        'client_id': client_id,
        'client_secret': os.environ['APPLE_SIGN_IN_CLIENT_SECRET'],
    }


def _cipher():
    return Fernet(os.environ['APPLE_SIGN_IN_ENCRYPTION_KEY'].encode())


def _subjects(user):
    return {identity.identity_data.get('sub') for identity in (getattr(user, 'identities', None) or [])
            if identity.provider == 'apple' and identity.identity_data and identity.identity_data.get('sub')}


async def save_for_deletion(db, user, authorization_code):
    subjects = _subjects(user)
    if not subjects:
        raise HTTPException(403, 'Sign in with Apple before saving its authorization.')
    credentials = _credentials()
    cipher = _cipher()
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.post(f'{APPLE_ISSUER}/auth/token', data={
            **credentials, 'grant_type': 'authorization_code', 'code': authorization_code,
        })
        response.raise_for_status()
        token = response.json()
    # This ID token comes directly from Apple's authenticated HTTPS token
    # endpoint, never from the caller. Bind the grant to the verified Supabase user.
    claims = jwt.decode(token['id_token'], options={'verify_signature': False})
    if (claims.get('iss') != APPLE_ISSUER or claims.get('aud') != credentials['client_id']
            or claims.get('sub') not in subjects):
        raise HTTPException(403, 'Apple authorization does not match this account.')
    refresh_token = token['refresh_token']
    if not isinstance(refresh_token, str) or not refresh_token:
        raise ValueError('Apple did not return a refresh token')
    user_id = str(user.id)
    encrypted = cipher.encrypt(f'{user_id}:{refresh_token}'.encode()).decode()
    await execute_query(db.table(TABLE).upsert({'user_id': user_id, 'encrypted_refresh_token': encrypted}))


async def revoke_before_deletion(db, user):
    if not _subjects(user):
        return
    user_id = str(user.id)
    rows = (await execute_query(db.table(TABLE).select('encrypted_refresh_token').eq('user_id', user_id))).data
    if not rows:
        # A failed or interrupted first sign-in can leave an account before
        # its Apple code was exchanged. Let the user erase that account too.
        return
    owner, token = _cipher().decrypt(rows[0]['encrypted_refresh_token'].encode()).decode().split(':', 1)
    if owner != user_id:
        raise ValueError('Apple authorization owner mismatch')
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.post(f'{APPLE_ISSUER}/auth/revoke', data={
            **_credentials(), 'token': token, 'token_type_hint': 'refresh_token',
        })
        response.raise_for_status()
