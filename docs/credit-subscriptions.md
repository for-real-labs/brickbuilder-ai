# Monthly credits and subscriptions

## Launch status

Launch is on hold at Jake's request on October 21, 2026. Keep this implementation
on `ragnarok`; do not merge or deploy it to production without a new launch request.
The billing changes were reverted from `main` in #293, and `ragnarok` includes that
updated history with the implementation restored only on this branch.

The production database migration and Stripe catalog were already provisioned.
They remain dormant: `billing_settings.enabled=false`, no live subscriptions or
paid subscription invoices, and no billing API deployed. The existing Stripe
webhook still receives only `checkout.session.completed`. Do not reapply the
recorded migration or enable billing as part of updating this branch. Recheck the
deployment and account state before any future launch.

## Proposed plans

The proposed launch follows Meshy's balance indicator, plan comparison modal,
creation-page promotion, low-credit nudge, usage history, and hosted billing flow.
BrickBuilder keeps its own colors, copy, and Build Buddies. It uses monthly plans
only, with no annual commitment or one-off packs:

| Plan | USD / month | Monthly credits |
| --- | ---: | ---: |
| Free | $0 | 5 |
| Builder | $5 | 30 |
| Creator | $12 | 100 |
| Master Builder | $24 | 300 |

The decision uses observed usage, not generation costs. The production data window
was September 22, 2026 00:00 UTC through October 22, 2026 00:00 UTC, queried during
October 21. The end of the window includes the incomplete current day.

Persisted successful generations and AI edits, excluding known internal accounts
and free operations (manual update, resize, and LDraw upload), showed 85 signed-in
builders and 1,369 builds/edits. Median usage was 3; the 75th, 90th, and 95th
percentiles were 10, 45, and 87; the maximum was 266. There were 30 builders active
on two or more days. Of the 85 builders, 56 used 1–5 credits, 20 used 6–30, 6 used
31–100, and 3 used more than 100.

PostHog production project 332024 recorded 9,248 distinct page-view visitors, 890
people clicking landing-page generation, 462 people with `generation_started`,
280 sending Build Buddy messages, and 45 clicking a generated-model order button
in the same window. Events and persisted jobs measure different things, and event
coverage changed during the period. These are not checkout conversion rates.
No Postmark source was available in this repository.

Five free credits cover the observed light-use majority. Thirty credits offer an
accessible next step; 100 covers usage around the 95th percentile; 300 covers the
observed upper range. The $5/$12/$24 prices are launch hypotheses for those usage
segments, not measured willingness to pay or revenue forecasts. Use checkout,
paid subscription, retention, and cancellation evidence to adjust them later.

Meshy's signed-in pricing offered subscriber-only one-off credit packs in addition
to monthly and annual plans. Its modal required an active subscription to buy and
use purchased credits, which do not expire. References:
[pricing](https://www.meshy.ai/pricing) and
[credit help](https://help.meshy.ai/en/articles/9991981-how-do-meshy-credits-work).

## Credit behavior

- One new AI build or AI edit reserves one credit atomically when its generation
  row is created. Uploading LDraw, manual edits, resizing, instructions, and
  downloads do not consume credits. The existing daily attempt limit remains.
- Monthly credits are spent before nonexpiring bonus credits. Existing profile
  balances are preserved as live bonus credits once during migration.
- Free credits reset at the beginning of each UTC calendar month. Paid credits
  reset on a verified paid Stripe invoice for a new billing period. They do not
  roll over. Expired paid monthly credits cannot be spent.
- Failed or canceled jobs refund their original reservation once. A monthly
  credit refund cannot replenish a different billing period.
- Upgrades grant the positive allowance difference after a paid invoice. The
  highest allowance already granted in that period prevents downgrade/re-upgrade
  cycling from creating extra credits. Downgrades are scheduled for renewal.
- Billing → Cancel subscription opens Stripe's cancellation confirmation.
  Cancellation is at period end; then the account returns to Free. Saved models
  and bonus credits remain. Stripe also provides receipts and payment updates.
- Test and live wallets are isolated. Anonymous trials and the internal API-key
  developer identity retain their existing behavior. Local offline mode does not
  require a subscription.

## Operations

1. Apply `20261022000000_credit_subscriptions.sql` transactionally, recording that
   migration only. Do not apply unrelated pending production migrations. The
   singleton `billing_settings.enabled` starts false.
2. Run `backend/scripts/provision_billing.py --env-file <existing environment>` for
   sandbox resources, then add `--live` for live resources. It creates/reuses
   versioned monthly prices and a portal with cancellation enabled, without
   charging anyone. Save the returned portal IDs to the corresponding columns
   in `billing_settings` using service/admin access.
3. Deploy the backend and frontend. Preserve the existing Stripe keys and webhook
   signing secret. Add `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.paid`, `invoice.payment_failed`, and
   `checkout.session.async_payment_succeeded` to the existing endpoint's events,
   retaining `checkout.session.completed` and any other existing events.
4. Verify the deployed commit, prices, cancellation configuration, authenticated
   billing routes, and checkout. Set `billing_settings.enabled=true` only when
   these are ready. Public `/billing/plans` reports the current enabled state.

The wallet and ledger are service-only. Browser writes to generation status and
legacy profile credits are disabled to prevent forged refunds or bypassing
admission. Ownership comes from verified authentication; browser input never
selects a Stripe customer, price amount, return URL, or subscription ID. Existing
physical-kit payments continue through their original webhook handler.

Billing webhooks fetch the current Stripe subscription rather than trusting an
old event snapshot, verify customer/mode/price, and apply paid invoices once.
`POST /billing/sync` reconciles the authenticated customer's checkout or current
subscription after return from Stripe. Failed webhook processing returns an
error so Stripe retries. Monitor delivery failures in Stripe.

To pause new purchases and metering, set `billing_settings.enabled=false`.
Existing subscriptions still renew unless canceled in Stripe; do not describe a
feature-flag pause as a subscription cancellation. Keep the billing portal and
webhook service available for existing customers.

Tests cover concurrent admission, no double charging, refunds, invoice replay,
renewal, upgrades, unpaid invoices, cancellation, permissions, test/live isolation,
checkout ownership, redirects, and UI interactions. Launch validation also used
a real Stripe sandbox subscription for paid invoice, upgrade, replay, portal, and
scheduled/final cancellation behavior. No live payment was made for testing.

PostHog captures pricing views, plan selections, checkout starts/failures, upgrade
and nudge interactions, billing navigation, confirmation, and cancellation clicks.
Client confirmation events are diagnostic; Stripe invoices are the source of
truth for paid revenue.
