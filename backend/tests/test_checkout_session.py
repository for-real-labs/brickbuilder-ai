import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException
from src.requests import createCheckoutSession as endpoint


@pytest.mark.parametrize("mode", ["hosted", "embedded", "elements"])
def test_checkout_preserves_shipping_metadata_and_returns_matching_response(monkeypatch, mode):
    monkeypatch.setenv("API_MODE", "local")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_fake")
    monkeypatch.setenv("SITE_URL", "http://localhost:5173/")
    monkeypatch.setattr(endpoint, "track_api_call", lambda **kwargs: None)
    monkeypatch.setattr(endpoint, "generation_storage", SimpleNamespace(get_generation=AsyncMock(return_value={"parts_list_csv_url": "https://example.com/parts.csv"})))
    create = Mock(return_value=SimpleNamespace(id="cs_test_fake", url="https://checkout.stripe.com/test", client_secret="cs_test_fake_secret_test"))
    monkeypatch.setattr(endpoint.stripe.checkout.Session, "create", create)
    response = asyncio.run(endpoint.create_checkout_session(endpoint.CreateCheckoutSessionRequest(generationId="model", brickowlCartId="cart", priceCents=1500, name="  Larfleeze – Regular Kit  ", uiMode=mode), {}))
    options = create.call_args.kwargs
    assert options["metadata"] == {"generationId": "model", "brickowlCartId": "cart", "partsListCsvUrl": "https://example.com/parts.csv"}
    assert options["shipping_address_collection"] == {"allowed_countries": ["US", "CA"]}
    assert options["line_items"][0]["price_data"]["unit_amount"] == 1500
    assert options["line_items"][0]["price_data"]["product_data"]["name"] == "Larfleeze – Regular Kit"
    if mode == "elements":
        assert options["ui_mode"] == "elements"
        assert options["stripe_version"] == "2026-09-30.endive"
        assert options["return_url"] == "http://localhost:5173/success?session_id={CHECKOUT_SESSION_ID}"
        assert "success_url" not in options and "cancel_url" not in options
        assert "redirect_on_completion" not in options
        assert response.client_secret == "cs_test_fake_secret_test"
        assert response.checkout_url is None
    elif mode == "embedded":
        assert options["ui_mode"] == "embedded"
        assert options["redirect_on_completion"] == "if_required"
        assert options["return_url"] == "http://localhost:5173/success?session_id={CHECKOUT_SESSION_ID}"
        assert "success_url" not in options and "cancel_url" not in options
        assert response.client_secret == "cs_test_fake_secret_test"
        assert response.checkout_url is None
    else:
        assert options["cancel_url"] == "http://localhost:5173/order"
        assert response.checkout_url == "https://checkout.stripe.com/test"
        assert response.client_secret is None


def test_missing_parts_csv_does_not_create_a_stripe_session(monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_fake")
    monkeypatch.setenv("API_MODE", "local")
    monkeypatch.setenv("SITE_URL", "http://localhost:5173")
    monkeypatch.setattr(endpoint, "track_api_call", lambda **kwargs: None)
    monkeypatch.setattr(endpoint, "generation_storage", SimpleNamespace(get_generation=AsyncMock(return_value={"id": "model"})))
    create = Mock()
    monkeypatch.setattr(endpoint.stripe.checkout.Session, "create", create)
    with pytest.raises(HTTPException) as error:
        asyncio.run(endpoint.create_checkout_session(endpoint.CreateCheckoutSessionRequest(generationId="model", uiMode="embedded"), {}))
    assert error.value.status_code == 400
    create.assert_not_called()
