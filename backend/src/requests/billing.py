"""Authenticated billing routes. Browser input never controls prices or owners."""
import logging
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal

from ..utils import billing
from ..utils.auth import get_optional_identity

router = APIRouter(prefix="/billing", tags=["billing"])
logger = logging.getLogger(__name__)


class CheckoutRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plan_key: Literal["builder", "creator", "master"]


class PortalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["manage", "cancel"] = "manage"


class SyncRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: str | None = Field(default=None, pattern=r"^cs_[A-Za-z0-9_]+$", max_length=300)


async def run(operation):
    try:
        return await operation
    except HTTPException:
        raise
    except Exception as error:
        logger.error("Billing operation failed (%s)", type(error).__name__)
        raise HTTPException(503, "Billing is temporarily unavailable. Please try again.") from error


@router.get("/plans")
async def plans():
    enabled = False
    capacity = {"available": False, "checkout_available": False}
    try:
        config = await billing.settings()
        enabled = bool(config["enabled"] and config.get("policy_version") == 2)
        if enabled:
            capacity = await billing.capacity()
    except Exception:
        pass
    return {"plans": billing.PLANS, "enabled": enabled, **capacity}


@router.get("/account")
async def account(identity: dict = Depends(get_optional_identity)):
    return await run(billing.account(identity))


@router.post("/checkout")
async def checkout(request: CheckoutRequest, identity: dict = Depends(get_optional_identity)):
    return await run(billing.checkout(identity, request.plan_key))


@router.post("/portal")
async def portal(request: PortalRequest, identity: dict = Depends(get_optional_identity)):
    return await run(billing.portal(identity, cancel=request.action == "cancel"))


@router.post("/sync")
async def sync(request: SyncRequest, identity: dict = Depends(get_optional_identity)):
    return await run(billing.sync_checkout(identity, request.session_id))
