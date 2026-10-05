import asyncio
import time
from types import SimpleNamespace
from unittest.mock import Mock

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from fastapi import HTTPException
from starlette.requests import Request

from src.utils import auth


SECRET = 'unit-test-supabase-secret-at-least-32-chars'
ISSUER = 'https://project.example.com/auth/v1'


def claims(**overrides):
    return {'sub': 'account-owner', 'email': 'builder@example.test',
            'role': 'authenticated', 'iss': ISSUER, 'aud': 'authenticated',
            'exp': int(time.time()) + 3600, **overrides}


@pytest.fixture
def signing(monkeypatch):
    monkeypatch.setattr(auth, 'SUPABASE_ISSUER', ISSUER)
    monkeypatch.setattr(auth, 'SUPABASE_JWT_SECRET', SECRET)
    jwks = Mock()
    monkeypatch.setattr(auth, 'supabase_jwks_client', jwks)
    return jwks


def test_legacy_hs256_tokens_remain_valid(signing):
    token = jwt.encode(claims(), SECRET, algorithm='HS256')
    assert auth.extract_user_from_token(token)['user_id'] == 'account-owner'
    signing.get_signing_key_from_jwt.assert_not_called()


@pytest.mark.parametrize('algorithm', ['ES256', 'RS256'])
def test_project_public_keys_verify_modern_supabase_tokens(signing, monkeypatch, algorithm):
    key = (ec.generate_private_key(ec.SECP256R1()) if algorithm == 'ES256'
           else rsa.generate_private_key(public_exponent=65537, key_size=2048))
    signing.get_signing_key_from_jwt.return_value = SimpleNamespace(key=key.public_key())
    # Public key authentication does not require the old shared JWT secret.
    monkeypatch.setattr(auth, 'SUPABASE_JWT_SECRET', None)
    token = jwt.encode(claims(), key, algorithm=algorithm, headers={'kid': 'project-key'})
    assert auth.extract_user_from_token(token)['email'] == 'builder@example.test'
    signing.get_signing_key_from_jwt.assert_called_once_with(token)


@pytest.mark.parametrize('overrides', [
    {'exp': 1}, {'iss': 'https://another-project.example.com/auth/v1'},
    {'aud': 'another-app'}, {'sub': ''}, {'role': 'service_role'},
    {'nbf': int(time.time()) + 3600},
])
def test_invalid_account_claims_are_rejected(signing, overrides):
    token = jwt.encode(claims(**overrides), SECRET, algorithm='HS256')
    with pytest.raises(auth.AuthError):
        auth.extract_user_from_token(token)


@pytest.mark.parametrize('missing', ['exp', 'iss', 'aud', 'sub'])
def test_required_account_claims_cannot_be_omitted(signing, missing):
    payload = claims()
    del payload[missing]
    with pytest.raises(auth.AuthError):
        auth.extract_user_from_token(jwt.encode(payload, SECRET, algorithm='HS256'))


def test_bad_signatures_and_unsigned_tokens_are_rejected(signing):
    for token in (
        jwt.encode(claims(), 'wrong-secret-at-least-32-characters', algorithm='HS256'),
        jwt.encode(claims(), '', algorithm='none'), 'malformed',
    ):
        with pytest.raises(auth.AuthError):
            auth.extract_user_from_token(token)


@pytest.mark.parametrize('algorithm', ['ES256', 'RS256'])
def test_asymmetric_signature_must_match_the_project_key(signing, algorithm):
    def make_key():
        return (ec.generate_private_key(ec.SECP256R1()) if algorithm == 'ES256'
                else rsa.generate_private_key(public_exponent=65537, key_size=2048))
    signing.get_signing_key_from_jwt.return_value = SimpleNamespace(key=make_key().public_key())
    token = jwt.encode(claims(), make_key(), algorithm=algorithm, headers={'kid': 'project-key'})
    with pytest.raises(auth.AuthError):
        auth.extract_user_from_token(token)


def test_jwks_failure_fails_closed_and_never_becomes_a_guest(signing, monkeypatch):
    key = ec.generate_private_key(ec.SECP256R1())
    token = jwt.encode(claims(), key, algorithm='ES256', headers={'kid': 'project-key'})
    signing.get_signing_key_from_jwt.side_effect = jwt.PyJWKClientError('Unavailable')
    monkeypatch.setattr(auth, 'supabase_client', object())
    request = Request({'type': 'http', 'headers': [(b'x-guest-session', b'a' * 64)]})
    with pytest.raises(HTTPException) as error:
        asyncio.run(auth.get_optional_identity(request, 'Bearer ' + token, None))
    assert error.value.status_code == 401


def test_modern_token_resolves_the_same_account_for_reads_and_required_auth(signing, monkeypatch):
    key = ec.generate_private_key(ec.SECP256R1())
    signing.get_signing_key_from_jwt.return_value = SimpleNamespace(key=key.public_key())
    monkeypatch.setattr(auth, 'supabase_client', object())
    monkeypatch.setattr(auth, 'SUPABASE_ENABLED', True)
    token = jwt.encode(claims(), key, algorithm='ES256', headers={'kid': 'project-key'})
    request = Request({'type': 'http', 'headers': [(b'x-guest-session', b'a' * 64)]})
    read = asyncio.run(auth.get_optional_identity(request, 'Bearer ' + token, None))
    required = asyncio.run(auth.verify_authentication('Bearer ' + token, None))
    assert read['user_id'] == required['user_id'] == 'account-owner'
    assert read['authenticated'] and not read['is_anonymous']
    assert read['guest_user_id'].startswith('guest_')
