"""Server-side attribution for the initial paid web subscription invoice."""
import hashlib
import os
import re
import time

import httpx
import stripe
from pydantic import BaseModel, ConfigDict, Field

from .database import execute_query

FBC = "meta_subscription_fbc"
USER_AGENT = "meta_subscription_ua"
CLICK_WINDOW = 7 * 86400
EVENT_WINDOW = 7 * 86400


class MetaClick(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,430}$")
    clicked_at: int = Field(gt=0)


def dataset_id():
    value = os.getenv("META_CONVERSIONS_DATASET_ID", "")
    return value if re.fullmatch(r"[0-9]{5,32}", value) else None


def checkout_metadata(click, headers, *, live):
    if (not live or not click or not dataset_id() or not os.getenv("META_CONVERSIONS_ACCESS_TOKEN")
            or headers.get("sec-gpc") == "1" or headers.get("dnt") == "1"):
        return {}
    ua = headers.get("user-agent", "")[:500]
    if not ua or not 0 <= time.time() - click.clicked_at / 1000 < CLICK_WINDOW:
        return {}
    return {FBC: f"fb.1.{click.clicked_at}.{click.id}", USER_AGENT: ua}


async def send(receipt, *, api_key, delivery, transport=None):
    invoice = receipt["invoice"]
    attribution = receipt.get("subscription_metadata") or {}
    fbc = attribution.get(FBC)
    agent = attribution.get(USER_AGENT)
    pixel = dataset_id()
    token = os.getenv("META_CONVERSIONS_ACCESS_TOKEN")
    amount = invoice.get("amount_paid")
    paid_at = (invoice.get("status_transitions") or {}).get("paid_at")
    if (not pixel or not token or not fbc or not agent or invoice.get("livemode") is not True
            or invoice.get("status") != "paid" or invoice.get("billing_reason") != "subscription_create"
            or invoice.get("paid_out_of_band") or invoice.get("currency") != "usd"
            or type(amount) is not int or amount <= 0 or type(paid_at) is not int
            or not 0 <= time.time() - paid_at < EVENT_WINDOW):
        return

    payments = await stripe.InvoicePayment.list_async(invoice=invoice["id"], status="paid", api_key=api_key)
    async for payment in payments.auto_paging_iter():
        if (payment.get("payment") or {}).get("type") in ("payment_intent", "charge") and (payment.get("amount_paid") or 0) > 0:
            break
    else:
        return

    event_id = hashlib.sha256(f"brickbuilder/subscribe/{invoice['id']}".encode()).hexdigest()
    event = {
        "event_name": "Subscribe",
        "event_time": paid_at,
        "event_id": event_id,
        "action_source": "website",
        "event_source_url": "https://brickbuilder.ai/checkout-plan",
        "user_data": {"fbc": fbc, "client_user_agent": agent},
        "custom_data": {"value": amount / 100, "currency": "USD"},
    }
    claim = await execute_query(delivery().upsert(
        {"event_id": event_id}, ignore_duplicates=True, on_conflict="event_id",
    ))
    if not claim.data:
        return

    # A lost response could mean Meta accepted the event. Keep the claim in
    # that case, so a Stripe retry cannot submit a second conversion.
    try:
        async with httpx.AsyncClient(transport=transport, timeout=5) as client:
            response = await client.post(
                f"https://graph.facebook.com/v25.0/{pixel}/events",
                headers={"Authorization": f"Bearer {token}"},
                json={"data": [event]},
            )
        acknowledged = response.is_success and (response.json() or {}).get("events_received") == 1
    except (httpx.HTTPError, ValueError, AttributeError):
        await execute_query(delivery().update({"status": "uncertain"}).eq("event_id", event_id))
        raise RuntimeError("Meta did not acknowledge the subscription event") from None

    if acknowledged:
        await execute_query(delivery().update({"status": "accepted"}).eq("event_id", event_id))
        return
    if response.status_code in (400, 401, 403, 404, 429):
        # These requests were rejected before Meta accepted an event.
        await execute_query(delivery().delete().eq("event_id", event_id))
    else:
        await execute_query(delivery().update({"status": "uncertain"}).eq("event_id", event_id))
    raise RuntimeError(f"Meta did not acknowledge the subscription event ({response.status_code})")
