"""Only JWT account owners can write keys; responses contain status, never keys."""
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, SecretStr
from ..utils.auth import get_optional_identity
from ..utils import provider_keys

router = APIRouter(prefix="/provider-keys", tags=["AI billing"])
Provider = Literal["openai", "anthropic"]

class KeyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    api_key: SecretStr

class PreferencesRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    billing_source: Literal["personal", "brickbuilder"]
    skip_confirmation: bool

async def run(operation, response):
    response.headers["Cache-Control"] = "no-store"
    try:
        return await operation
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(503, "AI key settings are temporarily unavailable.") from None

@router.get("")
async def status(response: Response, identity: dict = Depends(get_optional_identity)):
    return await run(provider_keys.status(identity), response)

@router.put("/preferences")
async def preferences(request: PreferencesRequest, response: Response, identity: dict = Depends(get_optional_identity)):
    return await run(provider_keys.update_preferences(identity, request.model_dump()), response)

@router.put("/{provider}")
async def save(provider: Provider, request: KeyRequest, response: Response, identity: dict = Depends(get_optional_identity)):
    key = request.api_key.get_secret_value().strip()
    if key.startswith("sk-ant-oat"):
        raise HTTPException(400, "Use an Anthropic API key, not a Claude subscription token.")
    if not 16 <= len(key) <= 4096 or not key.startswith("sk-") or any(c.isspace() for c in key):
        raise HTTPException(400, "Enter a valid provider API key.")
    return await run(provider_keys.save(identity, provider, key), response)

@router.delete("/{provider}")
async def remove(provider: Provider, response: Response, identity: dict = Depends(get_optional_identity)):
    return await run(provider_keys.remove(identity, provider), response)
