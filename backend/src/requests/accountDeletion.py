"""Self-service account erasure; identity always comes from the verified session."""
import asyncio
import logging
import os
from collections import defaultdict
from typing import Literal

import stripe
from fastapi import APIRouter, Depends, HTTPException, Header
from pydantic import BaseModel, ConfigDict

from ..utils import auth, billing
from ..utils.database import execute_query

router = APIRouter(prefix="/account", tags=["account"])
logger = logging.getLogger(__name__)


class DeletionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirmation: Literal["DELETE"]


async def delete_account(identity, token):
    user_id = billing.account_id(identity)
    db = billing.client()
    # JWT signatures alone remain valid after deletion. Check the live auth user.
    try:
        result = await asyncio.to_thread(db.auth.get_user, token)
        if not result.user or str(result.user.id) != user_id:
            raise ValueError("No matching account")
    except Exception:
        raise HTTPException(401, "Please sign in again before deleting your account.") from None
    # Prepare takes a database lock and prevents new builds during deletion.
    try:
        await billing.rpc("account_deletion_prepare", p_user_id=user_id)
    except Exception as error:
        if "ACCOUNT_HAS_ACTIVE_BUILDS" in str(error):
            raise HTTPException(409, "Cancel or finish your active builds, then delete your account.") from None
        raise
    rows = (await execute_query(db.table("billing_accounts").select("stripe_customer_id,livemode")
                                .eq("user_id", user_id))).data
    for row in rows:
        customer = row.get("stripe_customer_id")
        if not customer:
            continue
        key = os.getenv("STRIPE_SECRET_KEY_LIVE" if row["livemode"] else "STRIPE_SECRET_KEY")
        if not key:
            raise HTTPException(503, "Could not cancel your web subscription. Please retry deletion shortly.")
        subscriptions = await asyncio.to_thread(stripe.Subscription.list, customer=customer, status="all", limit=100, api_key=key)
        for sub in await asyncio.to_thread(lambda: list(subscriptions.auto_paging_iter())):
            if sub.status not in ("canceled", "incomplete_expired"):
                await asyncio.to_thread(stripe.Subscription.cancel, sub.id, api_key=key)
    # Read a bounded batch repeatedly. Failed storage deletion leaves account data
    # intact for retries; never claim completion after a partial cleanup.
    previous = None
    while True:
        files = await billing.rpc("account_deletion_files", p_user_id=user_id)
        if isinstance(files, dict):
            files = [files]
        if not files:
            break
        if files == previous:
            raise RuntimeError("Storage deletion did not make progress")
        previous = files
        grouped = defaultdict(list)
        for file in files:
            grouped[file["bucket_id"]].append(file["name"])
        for bucket, names in grouped.items():
            await asyncio.to_thread(db.storage.from_(bucket).remove, names)
    await billing.rpc("account_deletion_data", p_user_id=user_id)
    await asyncio.to_thread(db.auth.admin.delete_user, user_id)
    return {"deleted": True}


@router.post("/delete")
async def remove_account(body: DeletionRequest, identity: dict = Depends(auth.get_optional_identity),
                         authorization: str | None = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Sign in to delete your account.")
    try:
        return await delete_account(identity, authorization[7:])
    except HTTPException:
        raise
    except Exception:
        logger.exception("Account deletion could not complete")
        raise HTTPException(503, "Account deletion could not complete. Please retry; your request is safe to repeat.") from None
