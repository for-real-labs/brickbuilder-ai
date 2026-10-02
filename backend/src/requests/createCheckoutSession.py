import os
import logging
import asyncio
from typing import Literal, Optional

from pydantic import BaseModel
from fastapi import HTTPException

import stripe

from ..utils.posthog_client import track_api_call, track_error
from ..utils.generation_storage import generation_storage

logger = logging.getLogger(__name__)


class CreateCheckoutSessionRequest(BaseModel):
    name: Optional[str] = "BrickBuilder Model Kit"
    priceCents: Optional[int] = 4999
    quantity: Optional[int] = 1
    generationId: Optional[str] = None
    brickowlCartId: Optional[str] = None
    uiMode: Literal["hosted", "embedded", "elements"] = "hosted"


class CreateCheckoutSessionResponse(BaseModel):
    session_id: str
    checkout_url: Optional[str] = None
    client_secret: Optional[str] = None

# Stripe Documentation: https://docs.stripe.com/payments/accept-a-payment?platform=web&ui=stripe-hosted
async def create_checkout_session(request: CreateCheckoutSessionRequest, auth_info: dict):
    """Create a Stripe Checkout Session and return the session id.

    This replicates the behaviour in the original JS handler used by the frontend.
    """
    try:
        # Use live key in production, otherwise use test key
        api_mode = os.getenv("API_MODE", "local")
        if api_mode == "production":
            stripe_key = os.getenv("STRIPE_SECRET_KEY_LIVE")
        else:
            stripe_key = os.getenv("STRIPE_SECRET_KEY")
        
        site_url = os.getenv("SITE_URL")

        if not stripe_key:
            raise HTTPException(status_code=500, detail="Stripe secret key not configured")
        if not site_url:
            raise HTTPException(status_code=500, detail="SITE_URL not configured")

        stripe.api_key = stripe_key

        # Track API call
        user_email = auth_info.get("user_email", "anonymous") if isinstance(auth_info, dict) else "anonymous"
        track_api_call(endpoint="/create-checkout-session", user_id=user_email, request_data=request.dict())

        # Require generation ID
        if not request.generationId:
            raise HTTPException(status_code=400, detail="Generation ID is required")

        # Fetch parts_list_csv_url from generations table if generationId is provided
        parts_list_csv_url = None
        if request.generationId:
            generation = await generation_storage.get_generation(request.generationId)
            if not generation:
                raise HTTPException(status_code=404, detail=f"Generation {request.generationId} not found")
            parts_list_csv_url = generation.get("parts_list_csv_url")
            if not parts_list_csv_url:
                raise HTTPException(status_code=400, detail=f"Parts list CSV not found for generation {request.generationId}")

        # stripe python client is synchronous; run in thread executor to avoid blocking
        def _create_session():
            # Prepare metadata to pass through to webhook
            metadata = {}
            if request.generationId:
                metadata["generationId"] = request.generationId
            if request.brickowlCartId:
                metadata["brickowlCartId"] = request.brickowlCartId
            if parts_list_csv_url:
                metadata["partsListCsvUrl"] = parts_list_csv_url
            
            # Elements uses the current Checkout API while existing hosted and
            # embedded callers retain their previous API behavior.
            if request.uiMode == "elements":
                checkout_options = {
                    "ui_mode": "elements",
                    "stripe_version": "2026-09-30.endive",
                    "return_url": f"{site_url.rstrip('/')}/success?session_id={{CHECKOUT_SESSION_ID}}",
                }
            elif request.uiMode == "embedded":
                checkout_options = {
                    "ui_mode": "embedded",
                    "return_url": f"{site_url.rstrip('/')}/success?session_id={{CHECKOUT_SESSION_ID}}",
                    "redirect_on_completion": "if_required",
                }
            else:
                checkout_options = {
                    "success_url": f"{site_url.rstrip('/')}/success?session_id={{CHECKOUT_SESSION_ID}}",
                    "cancel_url": f"{site_url.rstrip('/')}/order",
                }
            return stripe.checkout.Session.create(
                line_items=[
                    {
                        "price_data": {
                            "currency": "usd",
                            "product_data": {"name": (request.name or "").strip()[:220] or "BrickBuilder Model Kit"},
                            "unit_amount": request.priceCents or 4999,
                        },
                        "quantity": request.quantity or 1,
                    }
                ],
                mode="payment",
                shipping_address_collection={"allowed_countries": ["US", "CA"]},
                metadata=metadata,
                **checkout_options,
            )

        session = await asyncio.get_event_loop().run_in_executor(None, _create_session)

        return CreateCheckoutSessionResponse(
            session_id=session.id,
            checkout_url=session.url if request.uiMode == "hosted" else None,
            client_secret=session.client_secret if request.uiMode in ("embedded", "elements") else None,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to create checkout session")
        track_error(error_type=type(e).__name__, error_message=str(e), endpoint="/create-checkout-session", user_id=user_email)
        raise HTTPException(status_code=500, detail="Failed to create checkout session")
