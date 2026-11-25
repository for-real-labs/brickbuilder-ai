"""Google Ads Data Manager HTTPS source, read from Stripe's live paid invoices."""
import csv
import io
import os
import secrets
from datetime import datetime, timedelta, timezone

import stripe
from fastapi import Depends, HTTPException, Response
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from ..utils import billing

COLUMNS = ("Google Click ID", "Conversion Name", "Conversion Time", "Conversion Value",
           "Conversion Currency", "Order ID", "Record Type")


def conversion_row(invoice):
    details = (invoice.get("parent") or {}).get("subscription_details") or invoice.get("subscription_details") or {}
    meta = details.get("metadata") or {}
    paid_at = (invoice.get("status_transitions") or {}).get("paid_at")
    if (not invoice.get("livemode") or invoice.get("status") != "paid" or not paid_at
            or invoice.get("billing_reason") != "subscription_create" or invoice.get("amount_paid", 0) <= 0
            or meta.get("integration") != billing.BILLING_TAG or not meta.get("gclid")):
        return None
    return (meta["gclid"], "subscription_confirmed",
            datetime.fromtimestamp(paid_at, timezone.utc).strftime("%Y-%m-%d %H:%M:%S+00:00"),
            f'{invoice["amount_paid"] / 100:.2f}', invoice["currency"].upper(), invoice["id"], "purchase")


def feed(credentials: HTTPBasicCredentials = Depends(HTTPBasic())):
    password = os.getenv("GOOGLE_ADS_FEED_PASSWORD")
    if not billing.live_mode() or not password or credentials.username != "googleads" or not secrets.compare_digest(
            password.encode(), credentials.password.encode()):
        raise HTTPException(401, "Unauthorized", headers={"WWW-Authenticate": "Basic"})
    since = datetime.now(timezone.utc) - timedelta(days=90)
    invoices = stripe.Invoice.list(status="paid", created={"gte": int(since.timestamp())},
                                   limit=100, api_key=billing.stripe_key())
    return Response(render_csv(invoices.auto_paging_iter()), media_type="text/csv",
                    headers={"Cache-Control": "no-store"})


def render_csv(invoices):
    result = io.StringIO()
    writer = csv.writer(result)
    writer.writerow(COLUMNS)
    count = 0
    for invoice in invoices:
        row = conversion_row(invoice)
        if row:
            writer.writerow(row)
            count += 1
    if not count:
        # Data Manager needs a row to discover columns. The import filters on
        # Record Type=purchase. This row has no click, action, amount or order.
        writer.writerow(("", "", "", "", "", "", "schema"))
    return result.getvalue()
