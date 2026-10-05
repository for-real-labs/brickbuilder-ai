# Order checkout

`/order` has two editable stages: Contact & delivery, and Payment.
Standard shipping is included automatically; the delivery country is part of the
address form. The model preview stays visible above the form on mobile, with
only the price breakdown collapsible. Checkout previews hide ruler/explode controls.
It supports the existing US/Canada standard shipping option and kit discount.
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
server; it does not trust the amount supplied by the browser. The returned quote
updates the displayed total before payment. The existing
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
