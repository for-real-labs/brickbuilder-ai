# Plan checkout

Web plan selection opens `/checkout-plan?plan=builder` or `?plan=creator`.
The page uses the model checkout layout and shared `CheckoutPayment` component.
Guests create an account or sign in inline; email verification stays on the page,
and Google returns to the selected plan. Signed-in visitors go directly to payment.
There is no shipping, full-name, or delivery form. Stripe collects only necessary
payment information; the Payment Element uses minimal required billing address fields.
Card, Apple Pay and Google Pay follow the same configuration as model checkout.
Native iOS purchases continue using Apple.

The authenticated `/billing/checkout` endpoint accepts `ui_mode: elements`, uses
Stripe API `2026-09-30.endive`, and returns a session ID and client secret. Prices,
customer IDs, ownership metadata, and return URLs remain server-owned. Hosted
clients remain compatible. Existing subscriptions must be managed in Billing;
this page never creates a second subscription or redirects to hosted Stripe.
Session reuse requires matching plan and UI mode. Client secrets stay in memory,
are discarded when the account or plan changes, and are never persisted or tracked.
Completion returns to the existing `/billing` reconciliation and webhook flow.

# Example cards

The subscription popup uses eight-second 360° recordings of the actual saved
models, captured with `ThreeLDRViewer` (no build animation, square view, #f3ddd6
background) and encoded as 640px H.264 MP4s at 30 fps. Posters are the first frame.
Reduced-motion preferences and failed video loads use still posters.

Model statistics were verified November 4, 2026. Dimensions are rendered geometry
bounds converted at 0.04 cm per LDraw unit, displayed W × D × H (X × Z × Y).
Kit estimates use `getPrice.order_pricing.full_parts_cents`, not supplier cost,
and exclude shipping, tax and member discounts. Refresh the estimates and media
if these showcased models or the retail catalog change.

- Workshop: `3164643e-974e-452a-8819-a1cc7788a628`
- Lighthouse: `4e5a6629-bdd4-46d0-97cc-d7271691e60c`
- Tiger: `126a7995-3bfe-4744-8008-c9eb39d386f5`

## Promo access

The plans popup has a `promo` link below “Cancel anytime.” Signed-in users enter
codes through `/billing/promo`; the backend determines the user and billing mode.
The private `promocodes` table contains `code` and `type` (`builder` currently).
`friday13` grants the verified account email membership in `external_testers`.
Redemption is case-insensitive and repeat-safe, preserves spent credits, and
refreshes the billing display. Existing paid subscriptions keep their current
plan and billing; tester access applies when those subscriptions end.
The promo code and email are never included in promo analytics events.
