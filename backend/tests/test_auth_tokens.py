"""Session validation remains compatible during Supabase signing-key migration."""
import asyncio
import json
import time
from types import SimpleNamespace
from unittest.mock import Mock

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from fastapi import HTTPException

from src.utils import auth


@pytest.fixture
def token_environment(monkeypatch):
    monkeypatch.setattr(auth, "SUPABASE_URL", "https://project.supabase.co")
    monkeypatch.setattr(auth, "SUPABASE_JWT_SECRET", "legacy-test-secret" * 3)
    return {
        "iss": "https://project.supabase.co/auth/v1",
        "aud": "authenticated",
        "sub": "d43a65c0-a070-4f45-8ae9-1d923f361185",
        "email": "owner@example.test",
        "role": "authenticated",
        "exp": int(time.time()) + 300,
    }


def test_legacy_session_does_not_use_jwks(monkeypatch, token_environment):
    lookup = Mock(side_effect=AssertionError("Legacy sessions do not use JWKS"))
    monkeypatch.setattr(auth, "_get_jwks_client", lookup)
    token = jwt.encode(token_environment, auth.SUPABASE_JWT_SECRET, algorithm="HS256")
    assert auth.extract_user_from_token(token)["user_id"] == token_environment["sub"]
    lookup.assert_not_called()


@pytest.mark.parametrize("algorithm", ["ES256", "RS256"])
def test_asymmetric_session_uses_project_public_key(monkeypatch, token_environment, algorithm):
    private = ec.generate_private_key(ec.SECP256R1()) if algorithm == "ES256" else rsa.generate_private_key(public_exponent=65537, key_size=2048)
    client = SimpleNamespace(get_signing_key_from_jwt=Mock(return_value=SimpleNamespace(key=private.public_key())))
    lookup = Mock(return_value=client)
    monkeypatch.setattr(auth, "_get_jwks_client", lookup)
    token = jwt.encode(token_environment, private, algorithm=algorithm, headers={"kid": "project-key"})
    assert auth.extract_user_from_token(token)["email"] == "owner@example.test"
    lookup.assert_called_once_with("https://project.supabase.co/auth/v1")
    client.get_signing_key_from_jwt.assert_called_once_with(token)


@pytest.mark.parametrize("algorithm", ["HS256", "ES256"])
@pytest.mark.parametrize("invalid", ["issuer", "audience", "expired", "missing_exp", "missing_sub", "signature"])
def test_invalid_sessions_are_rejected(monkeypatch, token_environment, algorithm, invalid):
    claims = dict(token_environment)
    if invalid == "issuer":
        claims["iss"] = "https://another-project.supabase.co/auth/v1"
    elif invalid == "audience":
        claims["aud"] = "https://backend.example.test/mcp"
    elif invalid == "expired":
        claims["exp"] = int(time.time()) - 30
    elif invalid.startswith("missing_"):
        del claims[invalid.removeprefix("missing_")]
    if algorithm == "HS256":
        key = "wrong-secret" if invalid == "signature" else auth.SUPABASE_JWT_SECRET
    else:
        private = ec.generate_private_key(ec.SECP256R1())
        trusted = ec.generate_private_key(ec.SECP256R1()) if invalid == "signature" else private
        monkeypatch.setattr(auth, "_get_jwks_client", lambda issuer: SimpleNamespace(get_signing_key_from_jwt=lambda token: SimpleNamespace(key=trusted.public_key())))
        key = private
    token = jwt.encode(claims, key, algorithm=algorithm)
    with pytest.raises(auth.AuthError) as error:
        auth.extract_user_from_token(token)
    assert error.value.status_code == 401


def test_unsigned_session_is_rejected(token_environment):
    token = jwt.encode(token_environment, "", algorithm="none")
    with pytest.raises(auth.AuthError, match="Unsupported"):
        auth.extract_user_from_token(token)


def test_unknown_signing_key_cannot_authenticate(monkeypatch, token_environment):
    private = ec.generate_private_key(ec.SECP256R1())
    public_jwk = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(private.public_key()))
    public_jwk.update(kid="trusted-key", alg="ES256", use="sig")
    client = jwt.PyJWKClient("https://project.supabase.co/auth/v1/.well-known/jwks.json")
    monkeypatch.setattr(client, "fetch_data", lambda: {"keys": [public_jwk]})
    monkeypatch.setattr(auth, "_get_jwks_client", lambda issuer: client)
    trusted = jwt.encode(token_environment, private, algorithm="ES256", headers={"kid": "trusted-key"})
    assert auth.extract_user_from_token(trusted)["user_id"] == token_environment["sub"]
    unknown = jwt.encode(token_environment, private, algorithm="ES256", headers={"kid": "unknown-key"})
    with pytest.raises(auth.AuthError):
        auth.extract_user_from_token(unknown)


def test_jwks_outage_returns_401_instead_of_server_error(monkeypatch, token_environment):
    private = ec.generate_private_key(ec.SECP256R1())
    client = SimpleNamespace(get_signing_key_from_jwt=Mock(side_effect=jwt.PyJWKClientConnectionError("Unavailable")))
    monkeypatch.setattr(auth, "_get_jwks_client", lambda issuer: client)
    monkeypatch.setattr(auth, "SUPABASE_ENABLED", True)
    monkeypatch.setattr(auth, "supabase_client", object())
    token = jwt.encode(token_environment, private, algorithm="ES256")
    with pytest.raises(HTTPException) as error:
        asyncio.run(auth.verify_authentication("Bearer " + token, None))
    assert error.value.status_code == 401
