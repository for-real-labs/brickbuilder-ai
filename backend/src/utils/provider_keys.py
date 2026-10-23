"""Account-scoped encrypted credentials. Never change process-wide provider keys."""
import functools
import os
from contextvars import ContextVar
from uuid import UUID

from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException

from . import auth
from .database import execute_query

_credentials = ContextVar("generation_provider_credentials", default=None)


def owner(identity):
    if identity.get("is_anonymous") or identity.get("is_developer") or not identity.get("authenticated"):
        raise HTTPException(401, "Sign in to manage your AI keys.")
    try:
        return str(UUID(identity["user_id"]))
    except (ValueError, KeyError, TypeError):
        raise HTTPException(401, "Sign in to manage your AI keys.") from None


def cipher():
    try:
        return Fernet(os.environ["PROVIDER_KEYS_ENCRYPTION_KEY"].encode())
    except (KeyError, ValueError):
        raise HTTPException(503, "Personal API key storage is not configured.") from None


def table(name):
    if not auth.supabase_client:
        raise HTTPException(503, "AI key settings are unavailable.")
    return auth.supabase_client.table(name)


async def preferences(user_id):
    result = await execute_query(table("user_ai_preferences").select("billing_source,skip_confirmation").eq("user_id", user_id))
    return result.data[0] if result.data else {"billing_source": "brickbuilder", "skip_confirmation": False}


async def status(identity):
    user_id = owner(identity)
    prefs = await preferences(user_id)
    result = await execute_query(table("user_provider_keys").select("provider").eq("user_id", user_id))
    return {**prefs, "providers": [row["provider"] for row in result.data]}


async def save(identity, provider, key):
    user_id = owner(identity)
    # Bind ciphertext to its owner and provider to prevent row substitution.
    encrypted = cipher().encrypt(f"{user_id}:{provider}:{key}".encode()).decode()
    await execute_query(table("user_provider_keys").upsert({"user_id": user_id, "provider": provider, "encrypted_key": encrypted}, on_conflict="user_id,provider"))
    return await status(identity)


async def remove(identity, provider):
    await execute_query(table("user_provider_keys").delete().eq("user_id", owner(identity)).eq("provider", provider))
    return await status(identity)


async def update_preferences(identity, values):
    await execute_query(table("user_ai_preferences").upsert({"user_id": owner(identity), **values}, on_conflict="user_id"))
    return await status(identity)


async def resolve(request, identity, provider):
    """Resolve before admission. A missing/invalid personal key never falls back."""
    request._provider_api_key = None
    if identity.get("is_anonymous") or identity.get("is_developer") or not identity.get("authenticated"):
        if request.billing_source == "personal":
            owner(identity)
        return
    source = request.billing_source or "brickbuilder"
    if source != "personal":
        return
    if getattr(request, "auth_mode", "api_key") != "api_key":
        raise HTTPException(400, "Select API key authentication to use personal billing.")
    user_id = owner(identity)
    result = await execute_query(table("user_provider_keys").select("encrypted_key").eq("user_id", user_id).eq("provider", provider))
    if not result.data:
        raise HTTPException(400, f"Add your {provider} API key in AI billing settings, or select BrickBuilder credits.")
    try:
        plaintext = cipher().decrypt(result.data[0]["encrypted_key"].encode()).decode()
        prefix = f"{user_id}:{provider}:"
        if not plaintext.startswith(prefix):
            raise ValueError("Credential owner mismatch")
        request._provider_api_key = plaintext[len(prefix):]
    except (InvalidToken, ValueError, UnicodeError):
        raise HTTPException(503, "Your saved API key could not be read. Please replace it in settings.") from None


def personal_billing_active():
    return _credentials.get() is not None


def provider_env(name):
    credentials = _credentials.get()
    if credentials is not None and name in {"OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_WORKSPACE_ID"}:
        return credentials.get(name)
    return os.getenv(name)


def personal_billing_task(function):
    @functools.wraps(function)
    async def scoped(generation_id, request, *args, **kwargs):
        key = getattr(request, "_provider_api_key", None)
        credentials = None if not key else {("ANTHROPIC_API_KEY" if request.model.startswith("claude-") else "OPENAI_API_KEY"): key}
        token = _credentials.set(credentials)
        try:
            return await function(generation_id, request, *args, **kwargs)
        finally:
            _credentials.reset(token)
    return scoped
