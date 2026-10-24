import os
import json
import logging
from html import escape
from typing import Optional
from urllib.parse import urlencode

from pydantic import BaseModel
from fastapi import HTTPException, Request

import stripe
import resend

from ..utils.posthog_client import track_api_call, track_error
from ..utils.generation_storage import generation_storage
from ..utils.billing import handle_billing_event
from ..utils.order_email import order_email_content
from ..utils.instruction_links import new_instruction_key, instruction_key_hash, instruction_link

logger = logging.getLogger(__name__)


class StripeWebhookRequest(BaseModel):
    """Request model for Stripe webhook - the body will be handled directly from FastAPI Request"""
    pass


class StripeWebhookResponse(BaseModel):
    """Response model for Stripe webhook"""
    success: bool
    message: str = "Webhook processed successfully"


async def stripe_webhook(request: Request, auth_info: dict):
    """
    Handle Stripe webhook events
    
    Follows Stripe's webhook example:
    https://docs.stripe.com/webhooks?lang=python
    """
    try:
        # Get the endpoint secret from environment based on API_MODE
        api_mode = os.getenv("API_MODE", "local")
        if api_mode == "production":
            endpoint_secret = os.getenv("STRIPE_WEBHOOK_SECRET_LIVE")
        else:
            endpoint_secret = os.getenv("STRIPE_WEBHOOK_SECRET")
        
        if not endpoint_secret:
            logger.error("STRIPE_WEBHOOK_SECRET not configured")
            raise HTTPException(status_code=500, detail="Webhook secret not configured")

        # Get the raw body and signature header
        payload = await request.body()
        sig_header = request.headers.get('stripe-signature')
        
        event = None
        
        try:
            # Verify webhook signature and construct event
            event = stripe.Webhook.construct_event(
                payload, sig_header, endpoint_secret
            )
        except ValueError as e:
            # Invalid payload
            logger.error(f"Invalid payload: {e}")
            raise HTTPException(status_code=400, detail="Invalid payload")
        except stripe.error.SignatureVerificationError as e:
            # Invalid signature
            logger.error(f'⚠️  Webhook signature verification failed: {e}')
            raise HTTPException(status_code=400, detail="Invalid signature")

        # Track the webhook event
        track_api_call(
            endpoint="/stripe-webhook", 
            user_id="stripe-system", 
            request_data={"event_type": event.type, "event_id": event.id}
        )

        # Handle the event

        if await handle_billing_event(event):
            return StripeWebhookResponse(success=True)

        if event.type in ('checkout.session.completed', 'checkout.session.async_payment_succeeded'):
            session = event.data.object  # contains a stripe.checkout.Session
            logger.info(f"Checkout session completed: {session.id}")
            await handle_checkout_session_completed(session)
            
        elif event.type == 'payment_intent.succeeded':
            payment_intent = event.data.object  # contains a stripe.PaymentIntent
            logger.info(f"Payment intent succeeded: {payment_intent.id}")
            # TODO: Define and call a method to handle the successful payment intent
            # handle_payment_intent_succeeded(payment_intent)
            
        elif event.type == 'payment_intent.created':
            payment_intent = event.data.object  # contains a stripe.PaymentIntent
            logger.info(f"Payment intent created: {payment_intent.id}")
            # handle_payment_intent_created(payment_intent)
            
        elif event.type == 'payment_method.attached':
            payment_method = event.data.object  # contains a stripe.PaymentMethod
            logger.info(f"Payment method attached: {payment_method.id}")
            # TODO: Define and call a method to handle the successful attachment of a PaymentMethod
            # handle_payment_method_attached(payment_method)
            
        elif event.type == 'product.created':
            product = event.data.object  # contains a stripe.Product
            logger.info(f"Product created: {product.id}")
            # handle_product_created(product)
            
        elif event.type == 'price.created':
            price = event.data.object  # contains a stripe.Price
            logger.info(f"Price created: {price.id}")
            # handle_price_created(price)
            
        elif event.type == 'charge.succeeded':
            charge = event.data.object  # contains a stripe.Charge
            logger.info(f"Charge succeeded: {charge.id} for amount: {charge.amount}")
            # handle_charge_succeeded(charge)
            
        elif event.type == 'charge.updated':
            charge = event.data.object  # contains a stripe.Charge
            logger.info(f"Charge updated: {charge.id}")
            # handle_charge_updated(charge)
            
        else:
            logger.info(f'Unhandled event type: {event.type}')

        return StripeWebhookResponse(success=True)

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to process Stripe webhook")
        track_error(
            error_type=type(e).__name__, 
            error_message=str(e), 
            endpoint="/stripe-webhook", 
            user_id="stripe-system"
        )
        raise HTTPException(status_code=500, detail="Failed to process webhook")


def handle_payment_intent_succeeded(payment_intent):
    """Handle successful payment intent"""
    # TODO: Implement payment processing logic
    logger.info(f"Processing successful payment: {payment_intent.id}")
    # Example: Update database, send confirmation email, etc.
    pass


def handle_payment_method_attached(payment_method):
    """Handle successful payment method attachment"""
    # TODO: Implement payment method attachment logic
    logger.info(f"Processing payment method attachment: {payment_method.id}")
    # Example: Update customer record, etc.
    pass


async def handle_checkout_session_completed(session):
    """Handle completed checkout session"""
    logger.info(f"Processing completed checkout session: {session.id}")

    # Checkout passes its key per request; webhook workers must authenticate
    # independently rather than relying on Stripe's process-wide default.
    key_name = "STRIPE_SECRET_KEY_LIVE" if os.getenv("API_MODE", "local") == "production" else "STRIPE_SECRET_KEY"
    stripe_key = os.getenv(key_name)
    if not stripe_key:
        logger.error("Stripe secret key not configured for checkout fulfillment")
        raise HTTPException(status_code=500, detail="Payment configuration is unavailable")
    
    # Retrieve the full session object from Stripe API to ensure we have all properties
    # The webhook event object doesn't always include all session properties like shipping_details
    try:
        full_session = stripe.checkout.Session.retrieve(session.id, expand=["payment_intent"], api_key=stripe_key)
        logger.info(f"Retrieved full session from Stripe API")
    except Exception as e:
        logger.error(f"Failed to retrieve full session from Stripe: {e}")
        full_session = session  # Fallback to event data

    if full_session.get('payment_status') != 'paid':
        logger.info('Checkout %s is awaiting payment; no order or instruction access issued', session.id)
        return
    
    # Extract custom metadata
    metadata = full_session.get('metadata') or {}
    generation_id = metadata.get('generationId')
    brickowl_cart_id = metadata.get('brickowlCartId')
    logger.info(f"Checkout session metadata: generation_id={generation_id}, brickowl_cart_id={brickowl_cart_id}")
    
    # Get payment amount
    amount_total = full_session.get('amount_total', 0)
    
    # Get payment intent ID
    payment_intent_data = full_session.get('payment_intent')
    if metadata.get('shippingAddressProvided') == 'true' and isinstance(payment_intent_data, str):
        payment_intent_data = stripe.PaymentIntent.retrieve(payment_intent_data, api_key=stripe_key)
    payment_intent = payment_intent_data.get('id') if isinstance(payment_intent_data, dict) else payment_intent_data
    logger.info(f"Payment intent ID: {payment_intent}")
    
    logger.info(f"Checkout session metadata - Generation ID: {generation_id}, BrickOwl Cart ID: {brickowl_cart_id}, Amount: ${amount_total/100:.2f}")
    
    # Extract shipping information from session
    # Shipping details are in collected_information.shipping_details
    customer_details = full_session.get('customer_details') or {}
    collected_information = full_session.get('collected_information') or {}
    shipping_details = collected_information.get('shipping_details') or {}
    if metadata.get('shippingAddressProvided') == 'true':
        shipping_details = payment_intent_data.get('shipping') if isinstance(payment_intent_data, dict) else None
        if not shipping_details or not shipping_details.get('address'):
            # Let Stripe retry rather than recording an order without its address.
            raise HTTPException(status_code=500, detail='Paid order shipping address is unavailable')
    
    logger.info(f"Raw collected_information: {collected_information}")
    logger.info(f"Raw shipping_details: {shipping_details}")
    logger.info(f"Raw customer_details: {customer_details}")
    
    # Check collected_information.shipping_details (this is where Stripe puts it)
    if not shipping_details or not shipping_details.get('address'):
        logger.error(f"Shipping details not found in checkout session {full_session.id}. Check Stripe.")
        shipping_address = {
            'line1': 'Shipping details not found. Check stripe',
            'line2': None,
            'city': None,
            'state': None,
            'postal_code': None,
            'country': None
        }
        shipping_name = 'Not found'
    else:
        shipping_address = shipping_details.get('address', {})
        shipping_name = shipping_details.get('name')
    
    # Build shipping_info JSON object
    shipping_info = {
        'name': shipping_name,
        'email': customer_details.get('email'),
        'phone': customer_details.get('phone'),
        'instructions_postcard': metadata.get('shipInstructionsPostcard') == 'true',
        'address': {
            'line1': shipping_address.get('line1'),
            'line2': shipping_address.get('line2'),
            'city': shipping_address.get('city'),
            'state': shipping_address.get('state'),
            'postal_code': shipping_address.get('postal_code'),
            'country': shipping_address.get('country')
        }
    }
    
    if shipping_info['instructions_postcard']:
        shipping_info['instructions_postcard_size'] = '6x4in'

    logger.info(f"Shipping info - Name: {shipping_info['name']}, Email: {shipping_info['email']}, City: {shipping_info['address']['city']}, State: {shipping_info['address']['state']}, Country: {shipping_info['address']['country']}")

    # Create BrickOwl wishlist - DISABLED
    wishlist_name = f"GenerationID_{generation_id}"
    # brickowl_api_key = os.getenv("BRICKOWL_API_KEY")
    # try:
    #     from ..utils.brickowl_utils import create_wishlist_from_generation_id
    #     await create_wishlist_from_generation_id(
    #         generation_id=generation_id,
    #         api_key=brickowl_api_key,
    #         wishlist_name=wishlist_name
    #     )
    # 
    # except Exception as e:
    #     logger.error(f"Error creating BrickOwl wishlist for generation {generation_id}: {e}")

    # Update payment status in database
    try:
        instruction_key = new_instruction_key()
        order_id = await generation_storage.update_payment_status(
            generation_id=generation_id,
            amount_paid=amount_total,
            stripe_session_id=full_session.id,
            stripe_payment_intent=payment_intent,
            shipping_info=shipping_info,
            instructions_key_hash=instruction_key_hash(instruction_key),
        )
        
        if order_id:
            logger.info(f"Successfully updated payment status for generation {generation_id} with order ID {order_id}")
            
            # Send order confirmation email
            customer_email = customer_details.get('email')
            if customer_email:
                try:
                    resend_api_key = os.getenv("RESEND_API_KEY")
                    if resend_api_key:
                        resend.api_key = resend_api_key
                        
                        model_url = 'https://brickbuilder.ai/?' + urlencode({'id': generation_id, 'exact': '1'})
                        try:
                            generation = await generation_storage.get_generation(generation_id) or {}
                        except Exception:
                            logger.warning("Order preview unavailable; sending confirmation without it")
                            generation = {}
                        content = order_email_content(order_id, generation_id, generation, metadata.get('petId'), instruction_key=instruction_key)
                        
                        email_params = {
                            "from": "BrickBuilder <no-reply@info.brickbuilder.ai>",
                            "to": [customer_email],
                            "subject": "Your BrickBuilder Order Confirmation",
                            **content,
                        }
                        
                        email_response = resend.Emails.send(email_params)
                        logger.info(f"Successfully sent order confirmation email to {customer_email}")
                        
                        # Send internal notification email to owner
                        try:
                            shipping_addr = shipping_info.get('address', {}) if shipping_info else {}
                            addr_str = f"{shipping_addr.get('line1', '')}, {shipping_addr.get('city', '')}, {shipping_addr.get('state', '')} {shipping_addr.get('postal_code', '')}, {shipping_addr.get('country', '')}"
                            
                            owner_email_html = f"""
                                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                                    <h2 style="color: #ef4444;">New Order Received!</h2>
                                    <table style="width: 100%; border-collapse: collapse;">
                                        <tr><td style="padding: 8px; font-weight: bold;">Order ID:</td><td style="padding: 8px;">{order_id}</td></tr>
                                        <tr><td style="padding: 8px; font-weight: bold;">Generation ID:</td><td style="padding: 8px;">{generation_id}</td></tr>
                                        <tr><td style="padding: 8px; font-weight: bold;">Amount:</td><td style="padding: 8px;">${amount_total/100:.2f}</td></tr>
                                        <tr><td style="padding: 8px; font-weight: bold;">Customer:</td><td style="padding: 8px;">{shipping_info.get('name', 'N/A') if shipping_info else 'N/A'}</td></tr>
                                        <tr><td style="padding: 8px; font-weight: bold;">Email:</td><td style="padding: 8px;">{customer_email}</td></tr>
                                        <tr><td style="padding: 8px; font-weight: bold;">Ship To:</td><td style="padding: 8px;">{addr_str}</td></tr>
                                        <tr><td style="padding: 8px; font-weight: bold;">Instructions Post Card:</td><td style="padding: 8px;">{"Include 6 × 4 inch QR instructions postcard" if shipping_info.get("instructions_postcard") else "Not requested"}</td></tr>
                                        <tr><td style="padding: 8px; font-weight: bold;">Stripe Session:</td><td style="padding: 8px;">{full_session.id}</td></tr>
                                    </table>
                                    <p style="margin-top: 16px;"><a href="{escape(model_url, quote=True)}" style="color: #ef4444;">View model in BrickBuilder</a></p>
                                    <p><a href="{escape(instruction_link(generation_id, instruction_key), quote=True)}">Purchased instructions (no sign-in required)</a></p>
                                    <p><a href="{escape(instruction_link(generation_id, instruction_key, postcard=True), quote=True)}">Postcard preview with this order’s instruction QR code</a></p>
                                    <p style="margin-top: 16px;"><a href="https://dashboard.stripe.com/payments/{payment_intent}" style="color: #ef4444;">View in Stripe</a></p>
                                </div>
                            """
                            
                            owner_email_params = {
                                "from": "BrickBuilder <no-reply@info.brickbuilder.ai>",
                                "to": ["jakejohnson3700@gmail.com"],
                                "subject": f"New Order #{order_id} - ${amount_total/100:.2f}",
                                "html": owner_email_html,
                            }
                            
                            resend.Emails.send(owner_email_params)
                            logger.info(f"Sent owner notification email for order {order_id}")
                        except Exception as owner_email_error:
                            logger.error('Failed to send owner notification email (%s)', type(owner_email_error).__name__)
                        
                    else:
                        logger.warning("RESEND_API_KEY not configured, skipping order confirmation email")
                except Exception as email_error:
                    # Don't fail the webhook if email fails
                    logger.error('Failed to send order confirmation email (%s)', type(email_error).__name__)
            else:
                logger.warning("No customer email found, skipping order confirmation email")
            
            # Get and print the parts list for the generation. Uncomment if needed.
            # try:
            #     parts_list = await generation_storage.get_parts_list(generation_id)
            #     if parts_list:
            #         logger.info(f"Parts list for generation {generation_id}: {parts_list}")
            #     else:
            #         logger.warning(f"Could not retrieve parts list for generation {generation_id}")
            # except Exception as e:
            #     logger.error(f"Error retrieving parts list for generation {generation_id}: {e}")
        else:
            logger.info("No new order for checkout %s; skipping confirmation emails", full_session.id)
            
    except Exception as e:
        logger.error('Error recording paid order (%s)', type(e).__name__)
        raise HTTPException(503, 'Could not record the paid order. Please retry this webhook.') from e
    
    # Log the full stripe session object data (commented out to reduce noise)
    # logger.info(f"Complete checkout session data: {json.dumps(dict(session), indent=2, default=str)}")
    


    # TODO: Implement additional business logic here
    # Examples:
    # - Process BrickOwl cart using brickowl_cart_id
    # - Send confirmation email  
    # - Update inventory
    # - Trigger fulfillment process


def handle_payment_intent_created(payment_intent):
    """Handle payment intent creation"""
    # TODO: Implement payment intent creation logic
    logger.info(f"Processing payment intent creation: {payment_intent.id}")
    # Example: Log payment attempt, prepare for processing, etc.
    pass


def handle_product_created(product):
    """Handle product creation"""
    # TODO: Implement product creation logic
    logger.info(f"Processing product creation: {product.id} - {product.name}")
    # Example: Sync with internal catalog, update inventory, etc.
    pass


def handle_price_created(price):
    """Handle price creation"""
    # TODO: Implement price creation logic
    logger.info(f"Processing price creation: {price.id} for product: {price.product}")
    # Example: Update pricing tables, sync with billing system, etc.
    pass


def handle_charge_succeeded(charge):
    """Handle successful charge"""
    # TODO: Implement successful charge logic
    logger.info(f"Processing successful charge: {charge.id} for ${charge.amount/100:.2f}")
    # Example: Update order status, send receipt, trigger fulfillment, etc.
    pass


def handle_charge_updated(charge):
    """Handle charge updates"""
    # TODO: Implement charge update logic
    logger.info(f"Processing charge update: {charge.id}")
    # Example: Handle refunds, disputes, status changes, etc.
    pass
