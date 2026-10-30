# Order checkout

`/order` has two editable stages: Contact & delivery, and Payment.
Standard shipping is included automatically; the delivery country is part of the
address form, using Brickwith’s first/last name and address field order.
Address line 2 and State/Province are optional; no phone number is collected. The model preview stays visible above the form on mobile, with
only the price breakdown collapsible. Checkout previews hide ruler/explode controls.
It offers all 249 countries and regions listed in Brickwith’s checkout, verified
on October 9, 2026, with the standard shipping calculation. Kits are charged at full price without a launch discount.
The frontend/backend country snapshots are checked for parity by tests.
Model data survives a reload; contact details and payment client secrets stay in memory.

## Stripe configuration

Set `VITE_STRIPE_PUBLISHABLE_KEY` on the frontend to enable payment on `/order`.
Use a `pk_test_...` key with the backend's test secret locally and a matching
`pk_live_...` key with `STRIPE_SECRET_KEY_LIVE` in production. Never put a secret
key in a `VITE_` variable. The backend still uses `SITE_URL` for the success URL.

With a publishable key, the backend creates a Checkout Session with
`ui_mode=custom`, and Stripe's Payment Element securely collects payment details.
`/order` always requests this embedded payment mode. Missing configuration or
payment initialization failures show a retryable error on the page, retaining
contact details. It never falls back to a separate hosted payment page.

Payment methods are determined by the Stripe account and customer eligibility.
Enable desired methods in Stripe's Dashboard. Apple Pay and Google Pay also
require HTTPS and the appropriate domain registration. The UI does not offer
unconfigured cryptocurrency, newsletter, or referral services.

Checkout computes the charged price from the stored model's parts list on the
server; it does not trust the amount supplied by the browser. The returned quote includes `order_pricing` in integer cents and updates the displayed total before payment. Catalog `total_price` remains the supplier cost, not a retail total. The address is validated on the backend and supplied through
`payment_intent_data.shipping`; the webhook reads that address from the expanded
PaymentIntent. This supports Brickwith entries omitted from Stripe’s address
selector without putting addresses in session metadata or analytics. Older
clients retain Stripe’s compatible address selector. Phone collection is disabled.
The existing
`checkout.session.completed` webhook and generation/cart/CSV metadata remain
in use for fulfillment.

## Validation

Run `npm --prefix frontend test`, `npm --prefix frontend run build`, and
`cd backend && uv run pytest tests/test_checkout_session.py`.
The checkout tests cover step navigation, missing price recovery, contact-data
retention during retries, payment readiness and terms gates, Stripe failures,
server pricing, authorization, and rejection of a hosted checkout response.

## Wallet choices

Payment methods appear as Card, Apple Pay, PayPal, Google Pay. The 2025 North American PaymentInsights survey reports PayPal at 58%, Google Pay at 42%, and Apple Pay at 38% (PaymentsJournal: https://www.paymentsjournal.com/top-5-digital-wallet-brands/amp/).

Apple Pay and Google Pay use a Checkout Express Checkout Element and the existing session confirmation and fulfillment path. Card wallets are suppressed in the Payment Element to avoid duplication. HTTPS, registered payment domains, and supported browsers/devices are required. Unavailable wallets remain disabled with an explanation; card payment remains usable on local HTTP.

PayPal is explicitly disabled pending a separate PayPal integration: the current Stripe account is US based, while native Stripe PayPal processing supports European merchant accounts only (https://docs.stripe.com/payments/paypal). Do not enable the option without a real processing and fulfillment integration. Custom Checkout sessions restrict payment_method_types to card, which also covers Apple Pay and Google Pay, preventing unrelated installment methods from appearing.

Stripe.js v10 uses initCheckoutElementsSdk with ui_mode elements. Backend pins 2026-09-30.endive and uses allowed_payment_method_types for this mode and retains hosted, embedded, and custom compatibility for older clients.


## Instructions post card

Contact & delivery offers an unchecked `ship instructions post card` option.
The info button opens an accessible modal with the model name, its saved render
(or a fresh viewer capture), a theme based on the model’s subject, and a scannable
QR code linking to `https://brickbuilder.ai/instructions?id=<generation id>`.
When model data is available, the popup’s image area uses a transparent 3D viewer.
Drag/touch rotates the model, scroll/pinch zooms it, and arrow keys plus +/- offer
keyboard controls. Reset view restores the starting camera. The angle survives
closing and reopening the popup; this changes the example preview only. The
viewer mounts only while the popup is open.

The card is a 6 × 4 inch landscape example preview with a consistent 3:2 aspect
ratio on desktop and mobile. Fulfillment records the size as `6x4in`. If its model image is unavailable, the preview
shows that state rather than substituting another model.

The choice is sent as the boolean `shipInstructionsPostcard` in checkout creation.
Stripe metadata carries it through payment to the webhook, which saves
`instructions_postcard` and, when selected, `instructions_url` in the order’s
`shipping_info`. The owner notification includes whether to pack the card.
Older clients and existing Stripe sessions default to no postcard. Selecting it
does not change the kit’s price. Selection and preview analytics omit names,
contact details, and model images.

Postcard checks: `npm --prefix frontend test` and
`cd backend && uv run pytest tests/test_checkout_session.py tests/test_stripe_webhook.py`.
The frontend tests decode the rendered QR using an independent QR reader.

## Promotion codes

Physical-order sessions enable Stripe promotion codes. The payment step applies and
removes codes through Stripe, displays Stripe's returned total in both the payment
button and order summary, and blocks payment while the discount is changing.
Subscription and credit-pack checkout are unchanged. Member savings are already included in the kit line item. Shipping is a separate
Stripe shipping rate, so percentage promo discounts apply to model bricks only.

Live Stripe has the reusable `LINKEDIN` code backed by coupon
`brickbuilder_linkedin_20`: 20% off, forever, without expiration, a first-order
restriction, or a redemption limit. The coupon is not product-restricted in Stripe
because kit products are generated per order; code entry is enabled only in the
physical-order flow. Test-mode coupons must be configured separately.


## Paid plan savings and pricing

A verified active paid entitlement (Stripe or Apple, including existing Master
Builder subscriptions) receives 20% off physical model bricks. Credit packs,
guests, Free accounts and developer access do not qualify. Cancellation at period
end keeps eligibility until the paid period ends; the existing paid-feature grace
policy applies. An entitlement lookup failure blocks a fresh quote rather than
silently charging a member full price.

`utils/order_pricing.py` owns the pricing policy. The member brick price targets a
20% gross margin on catalog cost: `cost / 0.8`. The regular price grosses that up
by another `/ 0.8`, so the 20% member discount leaves the target margin intact.
Round the member target and regular price upward to whole cents, then round the
member charge half up. Supplier coupons are not assumed. Payment fees, postcard
costs and extra promotional discounts are outside this brick margin target.

Shipping is separate, has no added margin, and is excluded from the member discount.
US standard shipping uses direct Brickwith checkout quotes to the saved Chicago
destination, tested October 29, 2026. Prices interpolate between these measured
parts weights, rounding half up to cents:

| Parts weight | Standard shipping |
| --- | --- |
| 16 g | $4.08 |
| 160 g | $6.41 |
| 220 g | $7.21 |
| 550 g | $13.44 |
| 1.1 kg | $22.68 |
| 2.2 kg | $41.57 |
| 4.4 kg | $81.29 |

The two light samples used 100/1,000 medium-nougat 3673 pins (0.16 g each).
The remaining samples used 100/250/500/1,000/2,000 dark-tan 3001 bricks (2.2 g each).
Use exact catalog weights; the checkout rounds its displayed kg weight. Below
16 g, charge the smallest observed quote, $4.08. Above 4.4 kg, extrapolate the last
segment (about $18.05 per additional kg). These are estimates from one US
destination, not live carrier quotes; other ZIP codes and larger parcels may vary.

Other countries retain the previous two-month receipt calibration, matched by
supplier order ID with shared purchases counted once and cancelled purchases
excluded. Australia, Germany, Spain, the UK, Lithuania and Poland each have one
matched shipment; these use a $4 base plus a weight rate. Unmeasured countries
use the pooled receipt fit. US cart measurements do not establish international
rates. Recalibrate as more direct quotes become available, without committing
private addresses or order details.

The browser refreshes quotes when entering checkout, changing country or changing
identity. Cached catalog-only prices cannot be used as retail quotes. The server
rechecks the subscription and destination when creating payment. Legacy hosted
sessions without a supplied address are limited to the quoted US destination.
Modern on-page checkout still supports every listed destination.

Stripe receives the member price as the product's `unit_amount`, with a separate
fixed shipping rate. `allow_promotion_codes` remains enabled: a valid promo applies
on top of the member price without replacing member savings. The original regular
price and automatic savings remain visible when a promo is applied or removed.
Stripe session metadata records the regular brick price, membership savings and
quoted shipping for later reconciliation.
