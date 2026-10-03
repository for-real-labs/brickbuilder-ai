"""Opt-in localhost-only routes for project provider connections."""
import asyncio
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from pydantic import BaseModel, SecretStr

from ..utils.local_provider_connections import (
    PROVIDERS, attach_api_key, local_provider_connections, require_local_development,
)

ProviderId = Literal["openai", "anthropic", "fal"]


class PrivateProviderRoute(APIRoute):
    def get_route_handler(self):
        original_handler = super().get_route_handler()

        async def handler(request):
            try:
                return await original_handler(request)
            except RequestValidationError:
                # Default validation responses echo raw input, including
                # malformed API-key and authorization-code request bodies.
                raise HTTPException(status_code=422, detail="Invalid provider request") from None
        return handler


router = APIRouter(prefix="/local/providers", tags=["Local development"],
                   dependencies=[Depends(require_local_development)], route_class=PrivateProviderRoute)


class ProviderLoginRequest(BaseModel):
    restart: bool = False
    connection: Literal["google", "github"] = "google"


class ProviderCredentialRequest(BaseModel):
    api_key: SecretStr


class ProviderCodeRequest(BaseModel):
    code: SecretStr


@router.get("")
async def local_providers(response: Response):
    response.headers["Cache-Control"] = "no-store"
    statuses = await asyncio.gather(*(local_provider_connections.status(provider) for provider in PROVIDERS))
    return {"enabled": True, "providers": statuses}


@router.get("/{provider}")
async def local_provider_status(provider: ProviderId, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return await local_provider_connections.status(provider)


@router.post("/{provider}/login")
async def local_provider_login(provider: ProviderId, body: ProviderLoginRequest = ProviderLoginRequest()):
    try:
        return await local_provider_connections.start(provider, restart=body.restart, connection=body.connection)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from None


@router.delete("/{provider}/login")
async def cancel_local_provider_login(provider: ProviderId):
    await local_provider_connections.cancel(provider)
    return await local_provider_connections.status(provider)


@router.post("/{provider}/login/code")
async def local_provider_login_code(provider: ProviderId, body: ProviderCodeRequest):
    try:
        await local_provider_connections.submit_code(provider, body.code.get_secret_value())
        return await local_provider_connections.status(provider)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from None


@router.post("/{provider}/credentials")
async def local_provider_credentials(provider: ProviderId, body: ProviderCredentialRequest):
    try:
        attach_api_key(provider, body.api_key.get_secret_value())
        return await local_provider_connections.status(provider)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from None
    except OSError:
        raise HTTPException(status_code=500, detail="Could not save the project API key") from None


@router.delete("/{provider}/credentials")
async def remove_local_provider_credentials(provider: ProviderId):
    try:
        attach_api_key(provider, None)
        return await local_provider_connections.status(provider)
    except (OSError, ValueError):
        raise HTTPException(status_code=500, detail="Could not remove the project API key") from None
