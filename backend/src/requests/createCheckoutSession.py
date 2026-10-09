import os
import logging
import asyncio
import math
import json
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field, StrictBool, field_validator
from fastapi import HTTPException
import stripe

from ..utils.posthog_client import track_api_call, track_error
from ..utils.generation_storage import generation_storage
from ..utils.authorization import require_generation_access
from .getPrice import GetPriceRequest, GetPriceResponse, get_price

logger = logging.getLogger(__name__)

# Verified against Brickwith's checkout dropdown on 2026-10-09.
SHIPPING_COUNTRIES = json.loads((Path(__file__).resolve().parents[1] / 'data' / 'shipping_countries.json').read_text())
SHIPPING_COUNTRY_CODES = {row['code'] for row in SHIPPING_COUNTRIES}
# Stripe's address selector enum omits these ISO regions. New on-page orders
# supply their address via payment_intent_data.shipping instead of that selector.
STRIPE_SELECTOR_UNSUPPORTED = {'AS', 'CC', 'CU', 'CX', 'FM', 'HM', 'IR', 'KP', 'MH', 'MP', 'NF', 'PW', 'SY', 'UM', 'VI'}
STRIPE_SHIPPING_COUNTRIES = sorted(SHIPPING_COUNTRY_CODES - STRIPE_SELECTOR_UNSUPPORTED)


class ShippingAddress(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    line1: str = Field(min_length=1, max_length=200)
    line2: Optional[str] = Field(default=None, max_length=200)
    city: str = Field(min_length=1, max_length=200)
    state: Optional[str] = Field(default=None, max_length=200)
    postal_code: str = Field(min_length=1, max_length=200)
    country: str = Field(min_length=2, max_length=2)

    @field_validator('country')
    @classmethod
    def supported_country(cls, value: str) -> str:
        value = value.upper()
        if value not in SHIPPING_COUNTRY_CODES:
            raise ValueError('Unsupported shipping country')
        return value


class ShippingContact(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=400)
    address: ShippingAddress


class CreateCheckoutSessionRequest(BaseModel):
    name: Optional[str] = Field(default="BrickBuilder Model Kit", max_length=250)
    # Retained for older clients. The charged price is calculated on the server.
    priceCents: Optional[int] = Field(default=None, gt=0)
    quantity: int = Field(default=1, ge=1, le=1)
    generationId: Optional[str] = Field(default=None, max_length=100)
    brickowlCartId: Optional[str] = Field(default=None, max_length=100)
    uiMode: Literal["hosted", "custom", "embedded", "elements"] = "hosted"
    customerEmail: Optional[EmailStr] = None
    shipInstructionsPostcard: StrictBool = False
    shippingAddress: Optional[ShippingContact] = None


class CreateCheckoutSessionResponse(BaseModel):
    session_id: str
    checkout_url: Optional[str] = None
    client_secret: Optional[str] = None
    price_data: Optional[GetPriceResponse] = None
    shipping_address_provided: bool = False


def checkout_price_cents(quote: GetPriceResponse) -> int:
    """Match the existing order page's shipping calculation and 50% discount."""
    if (not math.isfinite(quote.total_price) or quote.total_price <= 0 or
            not math.isfinite(quote.total_weight) or quote.total_weight < 0):
        raise HTTPException(status_code=400, detail="Kit pricing is unavailable")
    # Match JavaScript's rounding of nonnegative cents, including .5 ties.
    shipping = math.floor(quote.total_weight * 1800 + 400 + 0.5)
    parts = max(math.floor(quote.total_price * 100 + 0.5) - shipping, 0)
    return math.floor(parts * 0.5 + 0.5) + math.floor(shipping * 0.5 + 0.5)


async def create_checkout_session(request: CreateCheckoutSessionRequest, auth_info: dict):
    """Create hosted or on-page Checkout using the same fulfillment webhook."""
    user_email = auth_info.get("user_email", "anonymous")
    try:
        stripe_key = os.getenv("STRIPE_SECRET_KEY_LIVE" if os.getenv("API_MODE", "local") == "production" else "STRIPE_SECRET_KEY")
        site_url = os.getenv("SITE_URL")
        if not stripe_key or not site_url:
            raise HTTPException(status_code=500, detail="Payment configuration is unavailable")
        if not request.generationId:
            raise HTTPException(status_code=400, detail="Generation ID is required")
        generation = await generation_storage.get_generation(request.generationId)
        if not generation:
            raise HTTPException(status_code=404, detail="Generation not found")
        require_generation_access(generation, auth_info, allow_community=True)
        if generation.get("status") != "completed":
            raise HTTPException(status_code=400, detail="Only completed models can be ordered")
        parts_list_csv_url = generation.get("parts_list_csv_url")
        if not parts_list_csv_url:
            raise HTTPException(status_code=400, detail="Kit parts list is unavailable")
        quote = await get_price(GetPriceRequest(generation_id=request.generationId), auth_info)
        amount = checkout_price_cents(quote)
        track_api_call(endpoint="/create-checkout-session", user_id=user_email,
                       request_data={"generationId": request.generationId, "uiMode": request.uiMode, "priceCents": amount})
        metadata = {"generationId": request.generationId, "partsListCsvUrl": parts_list_csv_url,
                    "shipInstructionsPostcard": str(request.shipInstructionsPostcard).lower()}
        if request.brickowlCartId:
            metadata["brickowlCartId"] = request.brickowlCartId
        params = {
            "line_items": [{"price_data": {
                "currency": "usd",
                "product_data": {"name": generation.get('name') or 'Custom brick model'},
                "unit_amount": amount,
            }, "quantity": 1}],
            "mode": "payment", "ui_mode": request.uiMode,
            "shipping_address_collection": {"allowed_countries": STRIPE_SHIPPING_COUNTRIES},
            "metadata": metadata,
            "phone_number_collection": {"enabled": False},
        }
        shipping_address_provided = request.shippingAddress is not None
        if shipping_address_provided:
            params.pop('shipping_address_collection')
            params['payment_intent_data'] = {'shipping': request.shippingAddress.model_dump(exclude_none=True)}
            metadata['shippingAddressProvided'] = 'true'
        return_url = f"{site_url.rstrip('/')}/success?session_id={{CHECKOUT_SESSION_ID}}"
        if request.uiMode != "hosted":
            # Apple Pay and Google Pay use the card rail. PayPal needs a separate US integration.
            params["allowed_payment_method_types" if request.uiMode == "elements" else "payment_method_types"] = ["card"]
            params["return_url"] = return_url
            if request.uiMode == "embedded":
                params["redirect_on_completion"] = "if_required"
            elif request.uiMode == "elements":
                params["stripe_version"] = "2026-09-30.endive"
        else:
            params["success_url"] = return_url
            params["cancel_url"] = f"{site_url.rstrip('/')}/order"
            if request.customerEmail:
                params["customer_email"] = str(request.customerEmail)
        session = await asyncio.to_thread(stripe.checkout.Session.create, **params, api_key=stripe_key)
        return CreateCheckoutSessionResponse(
            session_id=session.id, checkout_url=session.url,
            client_secret=session.client_secret if request.uiMode != "hosted" else None,
            price_data=quote, shipping_address_provided=shipping_address_provided,
        )
    except HTTPException:
        raise
    except Exception as error:
        logger.error("Failed to create checkout session (%s)", type(error).__name__)
        track_error(error_type=type(error).__name__, error_message="Failed to create checkout session",
                    endpoint="/create-checkout-session", user_id=user_email)
        raise HTTPException(status_code=500, detail="Failed to create checkout session") from error
