"""Verified Stripe subscriptions and the server-owned generation credit wallet."""
import asyncio
import os
import time
from datetime import datetime, timezone
from uuid import UUID

import stripe
from fastapi import HTTPException

from . import auth
from .database import execute_query

PLANS = (
    {"key": "free", "name": "Free", "monthly_cents": 0, "credits": 5},
    {"key": "builder", "name": "Builder", "monthly_cents": 900, "credits": 30},
    {"key": "creator", "name": "Creator", "monthly_cents": 1900, "credits": 75},
    {"key": "master", "name": "Master Builder", "monthly_cents": 3900, "credits": 180},
)
PAID_PLANS = {p["key"]: p for p in PLANS if p["monthly_cents"]}
BILLING_TAG = "brickbuilder_credits_v2"


def live_mode():
    return os.getenv("API_MODE", "local") == "production"


def stripe_key():
    key = os.getenv("STRIPE_SECRET_KEY_LIVE" if live_mode() else "STRIPE_SECRET_KEY")
    if not key:
        raise HTTPException(503, "Billing is temporarily unavailable. Please try again.")
    return key


def account_id(identity):
    if identity.get("is_anonymous") or identity.get("is_developer") or not identity.get("authenticated"):
        raise HTTPException(401, "Sign in to manage your credits and subscription.")
    try:
        return str(UUID(identity["user_id"]))
    except (KeyError, ValueError, TypeError):
        raise HTTPException(401, "Sign in to manage your credits and subscription.") from None


def client():
    if not auth.SUPABASE_ENABLED or not auth.supabase_client:
        raise HTTPException(503, "Subscriptions are available on the hosted BrickBuilder app.")
    return auth.supabase_client


async def rpc(name, **params):
    result = await execute_query(client().rpc(name, params))
    data = result.data
    return data[0] if isinstance(data, list) and len(data) == 1 else data


async def settings():
    result = await execute_query(client().table("billing_settings").select("*").eq("id", True).single())
    return result.data


async def require_enabled():
    config = await settings()
    if not config["enabled"] or config.get("policy_version") != 2:
        raise HTTPException(503, "Subscriptions are getting ready. Please check back shortly.")


async def capacity():
    return await rpc("billing_capacity", p_live=live_mode())


async def wallet(user_id):
    return await rpc("billing_account", p_user_id=user_id, p_live=live_mode())


def public_wallet(row):
    end = datetime.fromisoformat(row["period_end"].replace("Z", "+00:00"))
    remaining = row["monthly_remaining"] if end > datetime.now(timezone.utc) else 0
    bonus_available = min(row["bonus_remaining"], max(0, 5-row.get("bonus_used", 0)))
    return {
        "bonus_available": bonus_available,
        "plan_key": row["plan_key"], "monthly_credits": row["monthly_credits"],
        "monthly_remaining": remaining, "bonus_remaining": row["bonus_remaining"],
        "credits_remaining": remaining + bonus_available,
        "period_start": row["period_start"], "period_end": row["period_end"],
        "subscription_status": row["subscription_status"],
        "cancel_at_period_end": row["cancel_at_period_end"],
        "has_subscription": row["subscription_status"] not in ("none", "canceled", "incomplete_expired"),
    }


async def account(identity):
    user_id = account_id(identity)
    row = await wallet(user_id)
    history = await execute_query(client().table("billing_credit_history")
        .select("id,kind,amount,bucket,created_at").eq("user_id", user_id)
        .eq("livemode", live_mode()).order("id", desc=True).limit(30))
    config = await settings()
    return {**public_wallet(row), "history": history.data, "enabled": bool(config["enabled"] and config.get("policy_version") == 2), **(await capacity())}


def lookup_key(plan_key):
    return f"brickbuilder_{plan_key}_monthly_v2"


async def price_for(plan_key):
    plan = PAID_PLANS[plan_key]
    prices = await asyncio.to_thread(stripe.Price.list, active=True,
        lookup_keys=[lookup_key(plan_key)], limit=2, api_key=stripe_key())
    if len(prices.data) != 1:
        raise HTTPException(503, "This plan is temporarily unavailable. Please try again.")
    price = prices.data[0]
    recurring = price.get("recurring") or {}
    if (price.get("unit_amount") != plan["monthly_cents"] or price.get("currency") != "usd"
            or recurring.get("interval") != "month" or recurring.get("interval_count") != 1
            or price.get("livemode") is not live_mode()):
        raise HTTPException(503, "This plan is temporarily unavailable. Please try again.")
    return price


def site_url():
    # Never accept a redirect/customer/price from the browser.
    return os.getenv("SITE_URL", "https://brickbuilder.ai").rstrip("/")


async def portal(identity, *, cancel=False, plan_key=None):
    user_id = account_id(identity)
    row = await wallet(user_id)
    if not row.get("stripe_customer_id") or not row.get("stripe_subscription_id"):
        raise HTTPException(409, "You do not have a subscription to manage.")
    config = await settings()
    configuration = config.get("live_portal_id" if live_mode() else "test_portal_id")
    if not configuration:
        raise HTTPException(503, "Billing is temporarily unavailable. Please try again.")
    args = {"customer": row["stripe_customer_id"], "configuration": configuration,
            "return_url": site_url() + "/billing"}
    if cancel:
        args["flow_data"] = {"type": "subscription_cancel", "subscription_cancel": {"subscription": row["stripe_subscription_id"]}}
    elif plan_key:
        await require_enabled()
        if not (await capacity())["checkout_available"]:
            raise HTTPException(503, "Plan changes are temporarily at capacity. You can still manage or cancel your subscription.")
        sub = await asyncio.to_thread(stripe.Subscription.retrieve, row["stripe_subscription_id"], api_key=stripe_key())
        price = await price_for(plan_key)
        items = sub["items"]["data"]
        if len(items) != 1 or sub["customer"] != row["stripe_customer_id"]:
            raise HTTPException(409, "Please manage this subscription in billing settings.")
        args["flow_data"] = {"type": "subscription_update_confirm", "subscription_update_confirm": {
            "subscription": sub.id, "items": [{"id": items[0]["id"], "price": price.id, "quantity": 1}]}}
    session = await asyncio.to_thread(stripe.billing_portal.Session.create, **args, api_key=stripe_key())
    return {"url": session.url}


async def checkout(identity, plan_key):
    user_id = account_id(identity)
    await require_enabled()
    if not (await capacity())["checkout_available"]:
        raise HTTPException(503, "New subscriptions are temporarily at capacity. Please try again later. Existing subscriptions can still be managed or canceled in Billing.")
    if plan_key not in PAID_PLANS:
        raise HTTPException(400, "Choose a monthly plan.")
    acquired = await rpc("billing_checkout_lock", p_user_id=user_id, p_live=live_mode(), p_acquire=True)
    if not acquired:
        raise HTTPException(409, "Your checkout is already opening. Please try again in a moment.")
    try:
        row = await wallet(user_id)
        customer = row.get("stripe_customer_id")
        if not customer:
            created = await asyncio.to_thread(stripe.Customer.create, email=identity.get("user_email"),
                metadata={"brickbuilder_user_id": user_id, "integration": BILLING_TAG},
                idempotency_key=f"bb-customer-v1:{live_mode()}:{user_id}", api_key=stripe_key())
            customer = created.id
            await execute_query(client().table("billing_accounts").update({"stripe_customer_id": customer})
                .eq("user_id", user_id).eq("livemode", live_mode()))
        subscriptions = await asyncio.to_thread(stripe.Subscription.list, customer=customer, status="all", limit=100, api_key=stripe_key())
        active = [s for s in subscriptions.data if s.status not in ("canceled", "incomplete_expired")]
        if active:
            await sync_subscription(active[0].id)
            return await portal(identity, plan_key=plan_key)
        # Reuse the existing open checkout. Multiple tabs/plans cannot create
        # multiple payable sessions for the same account.
        opened = await asyncio.to_thread(stripe.checkout.Session.list, customer=customer, status="open", limit=100, api_key=stripe_key())
        for old in opened.data:
            if old.get("mode") == "subscription" and old.get("metadata", {}).get("integration") == BILLING_TAG:
                if old["metadata"].get("plan_key") == plan_key:
                    return {"url": old.url}
                await asyncio.to_thread(stripe.checkout.Session.expire, old.id, api_key=stripe_key())
        price = await price_for(plan_key)
        metadata = {"brickbuilder_user_id": user_id, "integration": BILLING_TAG, "plan_key": plan_key}
        session = await asyncio.to_thread(stripe.checkout.Session.create,
            customer=customer, client_reference_id=user_id, mode="subscription", payment_method_types=["card"],
            line_items=[{"price": price.id, "quantity": 1}], metadata=metadata,
            subscription_data={"metadata": metadata},
            success_url=site_url()+"/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}",
            cancel_url=site_url()+"/pricing?checkout=canceled", expires_at=int(time.time())+1800,
            custom_text={"submit": {"message": "Renews monthly until canceled. Credits reset each billing month and do not roll over. Cancel anytime in Billing; access continues through your paid period."}},
            api_key=stripe_key())
        return {"url": session.url}
    finally:
        await rpc("billing_checkout_lock", p_user_id=user_id, p_live=live_mode(), p_acquire=False)


def object_id(value):
    return value.get("id") if isinstance(value, dict) else value


def invoice_subscription(invoice):
    return object_id(invoice.get("subscription") or
        (invoice.get("parent") or {}).get("subscription_details", {}).get("subscription"))


def invoice_price(line):
    return object_id(line.get("price") or (line.get("pricing") or {}).get("price_details", {}).get("price"))


async def sync_subscription(subscription_id):
    version = int(time.time() * 1000)
    sub = await asyncio.to_thread(stripe.Subscription.retrieve, subscription_id,
        expand=["latest_invoice"], api_key=stripe_key())
    metadata = sub.get("metadata") or {}
    if metadata.get("integration") != BILLING_TAG:
        return
    user_id = str(UUID(metadata["brickbuilder_user_id"]))
    row = await wallet(user_id)
    if sub.get("livemode") is not live_mode() or sub["customer"] != row.get("stripe_customer_id"):
        raise ValueError("Subscription identity or mode mismatch")
    if row.get("stripe_subscription_id") not in (None, sub.id) and sub.status in ("canceled", "incomplete_expired"):
        return  # An old subscription's delayed deletion must not end its replacement.
    items = sub["items"]["data"]
    if len(items) != 1 or items[0].get("quantity") != 1:
        raise ValueError("Unexpected subscription items")
    item = items[0]
    price = item["price"]
    plan = next((p for k, p in PAID_PLANS.items() if price.get("lookup_key") == lookup_key(k)), None)
    recurring = price.get("recurring") or {}
    if (not plan or price.get("unit_amount") != plan["monthly_cents"] or price.get("currency") != "usd"
            or recurring.get("interval") != "month" or recurring.get("interval_count") != 1):
        raise ValueError("Unexpected subscription price")
    start = item.get("current_period_start") or sub.get("current_period_start")
    end = item.get("current_period_end") or sub.get("current_period_end")
    invoice = sub.get("latest_invoice")
    if isinstance(invoice, str):
        invoice = await asyncio.to_thread(stripe.Invoice.retrieve, invoice, api_key=stripe_key())
    paid = (isinstance(invoice, dict) and invoice.get("status") == "paid"
            and invoice.get("livemode") is live_mode() and invoice_subscription(invoice) == sub.id
            and any(invoice_price(line) == price.id for line in invoice.get("lines", {}).get("data", [])))
    await rpc("billing_sync_subscription", p_user_id=user_id, p_live=live_mode(), p_customer=sub["customer"],
        p_subscription=sub.id, p_status=sub.status, p_cancel=bool(sub.get("cancel_at_period_end")),
        p_version=version, p_plan=plan["key"], p_start=datetime.fromtimestamp(start, timezone.utc).isoformat(),
        p_end=datetime.fromtimestamp(end, timezone.utc).isoformat(), p_invoice=invoice.id if paid else None,
        p_allowance=plan["credits"] if paid else None)


async def sync_checkout(identity, session_id=None):
    user_id = account_id(identity)
    if session_id:
        session = await asyncio.to_thread(stripe.checkout.Session.retrieve, session_id, api_key=stripe_key())
        if (session.get("client_reference_id") != user_id or session.get("metadata", {}).get("integration") != BILLING_TAG
                or session.get("livemode") is not live_mode()):
            raise HTTPException(403, "This checkout belongs to another account.")
        subscription_id = object_id(session.get("subscription"))
        if subscription_id:
            await sync_subscription(subscription_id)
    else:
        row = await wallet(user_id)
        if row.get("stripe_subscription_id"):
            await sync_subscription(row["stripe_subscription_id"])
    return await account(identity)


async def handle_billing_event(event):
    """Return True for billing events; physical orders retain their existing handler."""
    obj = event.data.object
    related = (event.type.startswith(("customer.subscription.", "invoice.")) or
        (event.type in ("checkout.session.completed", "checkout.session.async_payment_succeeded") and obj.get("mode") == "subscription"))
    if not related:
        return False
    if event.get("livemode") is not live_mode():
        raise ValueError("Stripe webhook mode mismatch")
    if event.type.startswith("customer.subscription."):
        await sync_subscription(obj.id)
        return True
    if event.type.startswith("invoice."):
        subscription_id = invoice_subscription(obj)
        if subscription_id:
            await sync_subscription(subscription_id)
        return True
    if event.type in ("checkout.session.completed", "checkout.session.async_payment_succeeded") and obj.get("mode") == "subscription":
        subscription_id = object_id(obj.get("subscription"))
        if subscription_id:
            await sync_subscription(subscription_id)
        return True
    return False
