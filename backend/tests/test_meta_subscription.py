import asyncio
import json
from time import time
from types import SimpleNamespace
from unittest.mock import ANY
from threading import Lock
from unittest.mock import AsyncMock

import httpx
import pytest

from src.utils import billing, meta_subscription as meta


@pytest.fixture(autouse=True)
def configured_dataset(monkeypatch):
    monkeypatch.setenv("META_CONVERSIONS_DATASET_ID", "123456789")
    monkeypatch.setenv("META_CONVERSIONS_ACCESS_TOKEN", "test-token")


@pytest.mark.parametrize("live, headers, age, expected", [
    (True, {}, 1, True),
    (False, {}, 1, False),
    (True, {"sec-gpc": "1"}, 1, False),
    (True, {"dnt": "1"}, 1, False),
    (True, {}, meta.CLICK_WINDOW + 1, False),
    (True, {}, -60, False),
])
def test_checkout_collection_requires_permission_and_a_current_click(live, headers, age, expected):
    click = meta.MetaClick(id="click_test", clicked_at=int((time() - age) * 1000))
    actual = meta.checkout_metadata(click, {"user-agent": "Test Browser", **headers}, live=live)
    assert actual == ({meta.FBC: f"fb.1.{click.clicked_at}.click_test", meta.USER_AGENT: "Test Browser"} if expected else {})
    assert meta.checkout_metadata(None, {"user-agent": "Test Browser"}, live=live) == {}


@pytest.fixture
def receipt():
    return {
        "invoice": {
            "id": "in_example", "livemode": True, "billing_reason": "subscription_create",
            "currency": "usd", "status": "paid", "amount_paid": 299,
            "status_transitions": {"paid_at": int(time())},
        },
        "subscription_metadata": {meta.FBC: "fb.1.1795634212000.test_click", meta.USER_AGENT: "Test Browser"},
    }


class Payments:
    def __init__(self, payment_type):
        self.payment_type = payment_type

    async def auto_paging_iter(self):
        yield {"payment": {"type": self.payment_type}, "amount_paid": 299}


@pytest.mark.parametrize("invoice_update", [
    {"livemode": False},
    {"billing_reason": "subscription_cycle"},
    {"amount_paid": 0},
    {"status": "open"},
    {"paid_out_of_band": True},
    {"status_transitions": {"paid_at": 1}},
])
def test_nonconversions_never_reach_meta(monkeypatch, receipt, invoice_update):
    receipt["invoice"].update(invoice_update)
    list_payments = AsyncMock()
    monkeypatch.setattr(meta.stripe.InvoicePayment, "list_async", list_payments)
    asyncio.run(meta.send(receipt, api_key="stripe-test", delivery=None))
    list_payments.assert_not_called()


def test_payment_records_and_opt_in_are_required(monkeypatch, receipt):
    list_payments = AsyncMock(return_value=Payments("payment_record"))
    monkeypatch.setattr(meta.stripe.InvoicePayment, "list_async", list_payments)

    def unexpected(_request):
        pytest.fail("External payment records and missing consent must not send events")

    transport = httpx.MockTransport(unexpected)
    asyncio.run(meta.send(receipt, api_key="stripe-test", delivery=None, transport=transport))
    list_payments.assert_awaited_once_with(invoice="in_example", status="paid", api_key="stripe-test")
    receipt.pop("subscription_metadata")
    asyncio.run(meta.send(receipt, api_key="stripe-test", delivery=None, transport=transport))
    assert list_payments.await_count == 1


class DeliveryTable:
    def __init__(self):
        self.rows = {}
        self.lock = Lock()

    def __call__(self):
        return DeliveryQuery(self)


class DeliveryQuery:
    def __init__(self, table):
        self.table = table

    def upsert(self, row, *, ignore_duplicates, on_conflict):
        assert ignore_duplicates and on_conflict == "event_id"
        self.event_id = row["event_id"]
        self.op = "insert"
        return self

    def update(self, row):
        self.op = "update"
        self.status = row["status"]
        return self

    def delete(self):
        self.op = "delete"
        return self

    def eq(self, column, value):
        assert column == "event_id"
        self.event_id = value
        return self

    def execute(self):
        with self.table.lock:
            if self.op == "insert":
                if self.event_id in self.table.rows:
                    return SimpleNamespace(data=[])
                self.table.rows[self.event_id] = "sending"
                return SimpleNamespace(data=[{"event_id": self.event_id}])
            if self.op == "update":
                self.table.rows[self.event_id] = self.status
            else:
                self.table.rows.pop(self.event_id)


def test_simultaneous_stripe_webhooks_and_later_retry_send_one_conversion(monkeypatch, receipt):
    monkeypatch.setattr(meta.stripe.InvoicePayment, "list_async", AsyncMock(return_value=Payments("payment_intent")))
    delivery = DeliveryTable()
    events = []

    def fake_meta(request):
        assert request.url == "https://graph.facebook.com/v25.0/123456789/events"
        assert request.headers["authorization"] == "Bearer test-token"
        events.extend(json.loads(request.content)["data"])
        return httpx.Response(200, json={"events_received": 1})

    transport = httpx.MockTransport(fake_meta)

    async def replay():
        await asyncio.gather(*(meta.send(receipt, api_key="stripe-test", delivery=delivery, transport=transport) for _ in range(4)))
        await meta.send(receipt, api_key="stripe-test", delivery=delivery, transport=transport)

    asyncio.run(replay())
    assert len(events) == 1
    event = events[0]
    assert event["event_name"] == "Subscribe"
    assert event["custom_data"] == {"value": 2.99, "currency": "USD"}
    assert set(event["user_data"]) == {"fbc", "client_user_agent"}
    assert "in_example" not in event["event_id"]
    assert delivery.rows == {event["event_id"]: "accepted"}


def test_meta_rejection_releases_claim_and_retry_reuses_event_id(monkeypatch, receipt):
    monkeypatch.setattr(meta.stripe.InvoicePayment, "list_async", AsyncMock(return_value=Payments("payment_intent")))
    delivery = DeliveryTable()
    events = []

    def fake_meta(request):
        events.extend(json.loads(request.content)["data"])
        if len(events) == 1:
            return httpx.Response(429, json={"error": "rate limit"})
        return httpx.Response(200, json={"events_received": 1})

    transport = httpx.MockTransport(fake_meta)
    with pytest.raises(RuntimeError, match=r"subscription event \(429\)"):
        asyncio.run(meta.send(receipt, api_key="stripe-test", delivery=delivery, transport=transport))
    assert delivery.rows == {}
    asyncio.run(meta.send(receipt, api_key="stripe-test", delivery=delivery, transport=transport))
    assert len(events) == 2 and events[0] == events[1]


def test_ambiguous_delivery_is_held_for_review_without_resending(monkeypatch, receipt):
    monkeypatch.setattr(meta.stripe.InvoicePayment, "list_async", AsyncMock(return_value=Payments("payment_intent")))
    delivery = DeliveryTable()
    attempts = []

    def fake_meta(request):
        attempts.append(request.url)
        raise httpx.ReadTimeout("Meta may have received the request")

    transport = httpx.MockTransport(fake_meta)
    with pytest.raises(RuntimeError, match="did not acknowledge"):
        asyncio.run(meta.send(receipt, api_key="stripe-test", delivery=delivery, transport=transport))
    assert list(delivery.rows.values()) == ["uncertain"]
    asyncio.run(meta.send(receipt, api_key="stripe-test", delivery=delivery, transport=transport))
    assert len(attempts) == 1


def test_only_matched_paid_webhook_sends_meta_event(monkeypatch, receipt):
    from src.utils import purchase_email
    monkeypatch.setattr(billing, "live_mode", lambda: True)
    monkeypatch.setattr(billing, "stripe_key", lambda: "stripe-test")
    monkeypatch.setattr(billing, "sync_subscription", AsyncMock(return_value=receipt))
    monkeypatch.setattr(purchase_email, "send_plan_confirmation", AsyncMock())
    send = AsyncMock()
    monkeypatch.setattr(meta, "send", send)

    def invoice_event(kind, invoice_id):
        return stripe_event({"livemode": True, "type": kind,
                             "data": {"object": {"id": invoice_id, "subscription": "sub_example"}}})

    asyncio.run(billing.handle_billing_event(invoice_event("invoice.payment_succeeded", "in_example")))
    asyncio.run(billing.handle_billing_event(invoice_event("invoice.paid", "in_old")))
    send.assert_not_called()
    asyncio.run(billing.handle_billing_event(invoice_event("invoice.paid", "in_example")))
    send.assert_awaited_once_with(receipt, api_key="stripe-test", delivery=ANY)


def stripe_event(data):
    return billing.stripe.StripeObject.construct_from(data, None)
