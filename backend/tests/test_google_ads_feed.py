import pytest
from src.requests.google_ads_feed import conversion_row
from src.utils.billing import BILLING_TAG


def invoice():
    return dict(livemode=True, status="paid", status_transitions={"paid_at": 1000},
                billing_reason="subscription_create", amount_paid=299, currency="usd", id="in_1",
                parent={"subscription_details": {"metadata": {"integration": BILLING_TAG, "gclid": "click"}}})


def test_verified_invoice_export():
    assert conversion_row(invoice()) == ("click", "subscription_confirmed", "1970-01-01 00:16:40+00:00",
                                         "2.99", "USD", "in_1")


@pytest.mark.parametrize("change", [dict(livemode=False), dict(status="open"), dict(amount_paid=0),
                                    dict(billing_reason="subscription_cycle"), dict(parent={})])
def test_excluded_invoices(change):
    assert conversion_row(invoice() | change) is None
