# Monthly credits and subscriptions

## Launch state

The approved pricing is prepared on `ragnarok`, updated with `main` through
`01a5df8`. Production billing remains disabled until the production merge,
migration, catalog, webhooks and both deployed commits are verified. The earlier
billing migration `20261022000000` is already recorded in production; do not
reapply it. The new migration is `20261023000000_billing_pricing_v2.sql`.

## Plans

| Plan | USD / month | Monthly credits | Example use of the shared balance |
| --- | ---: | ---: | --- |
| Free | $0 | 5 | 5 Basic builds |
| Builder | $9 | 30 | 30 Basic or 2 All parts builds |
| Creator | $19 | 75 | 75 Basic or 5 All parts builds |
| Master Builder | $39 | 180 | 180 Basic or 12 All parts builds |

Basic generation and Basic AI edits cost 1 credit. All parts generation/edits and
AI text/image-to-mesh conversions cost 15 credits and require a paid plan. Modes
share a balance; the example counts are alternatives, not additive allowances.
Monthly plans only; no annual plans or one-off packs. Physical kits are separate.

Guests get one Basic trial attempt, enforced by persistent browser and IP
counters. A claimed successful or running trial deducts one credit from the
account's Free allowance if it belongs to the current month. Failed trials can
sign in for Free access. Existing guest counters are preserved. LDraw/GLB/OBJ
imports, manual edits, resizing, instructions and downloads do not use credits.
The default daily limit remains 10 attempts, with one active generation per user;
existing owner exemptions and account overrides remain intact.

The 31,700 prelaunch bonus credits are preserved. Users can redeem up to 5 per
UTC calendar month, after monthly credits, for Basic builds only. They never
expire. The account page separates the full legacy balance from credits usable
this month. This transition avoids letting old welcome balances bypass the paid
All parts requirement, without deleting those balances.

Free credits reset each UTC calendar month. Paid credits reset on a verified paid
Stripe invoice at the billing anniversary, without rollover. Upgrades grant only
the positive allowance difference; downgrade/re-upgrade cycling cannot mint more
credits. Downgrades take effect at renewal. Failed/canceled builds refund their
full 1- or 15-credit charge once, into its original period. Bonus refunds restore
the monthly redemption allowance only when returning to the same bonus month.

Billing → Cancel subscription opens Stripe confirmation. Cancellation takes
effect at period end; the remaining paid allowance stays available until then.
Saved models and legacy bonuses remain available afterward. Cancellation,
receipts and payment-method updates remain accessible during capacity pauses.

## Evidence and assumptions

The September 22–October 21, 2026 Chicago window contained 9,263 PostHog visitors
and 901 people clicking Generate. The latest complete weekly Generate audience
grew from 250 to 398. Generation event instrumentation began October 11; earlier
zeroes are not zero product usage. The database had 89 successful signed-in AI
builders and 1,407 AI builds, excluding known internal identities and imports.
Median signed-in use was 3 builds. These are usage observations, not measured
willingness to pay. Postmark was not available for this analysis.

Recorded AI spend for October 15–21 was approximately $3,797 including internal
accounts. Basic cost approximately $0.21 per successful build; All parts cost
approximately $2.95 including recorded failed-job spend. Reporting is incomplete,
especially for historical failures and some providers. Do not interpret missing
usage as zero cost or these figures as reconciled provider invoices.

Planning assumptions: 50% audience growth, 1–3% of Generate clickers subscribing,
60/30/10% paid-plan mix, 70% credit utilization, and $0.25 cost per weighted credit.
That suggests roughly 14–41 subscribers and $200–$600 MRR at 1.5× audience. The
central case models about $1,202 monthly AI spend including a $500 reserve;
3× audience models about $1,905. These estimates exclude legacy bonus redemption:
if all 317 legacy accounts redeem five extra credits, add roughly $396/month at
the planning rate. The spending guard also covers those builds.

At fixed traffic, the working hypothesis is 20–40% fewer active builders,
60–80% fewer AI generations and 90–98% fewer All parts generations. These are
scenario assumptions, not statistical forecasts. Measure actual conversion,
renewal, cancellations and generation mix after launch.

Meshy's balance badge, pricing modal, creation banner, low-credit nudge, usage
history and hosted billing informed the flow. BrickBuilder keeps its own design
and Build Buddies. Meshy also offers subscriber-only one-off credit packs in
addition to monthly/annual plans; BrickBuilder intentionally starts monthly only.
Sources: [pricing](https://www.meshy.ai/pricing) and
[credit help](https://help.meshy.ai/en/articles/9991981-how-do-meshy-credits-work).

## Spending safeguards and limitations

The $2,000 monthly operating target is split into $1,500 for generation and $500
for short assistant/title calls outside reserved jobs. Admission reserves $21 per
job atomically across API workers: the existing $20 provider limit plus a title
buffer. Only a successful Basic/All parts job with finalized reported usage
releases the unused amount. Failures, cancellations, incomplete reports and
legacy mesh jobs retain the conservative hold. Credit refunds never erase spend.
Short calls reserve a conservative token-price bound before contacting the
provider, settle on reported usage and retain the hold on unknown outcomes.

New checkouts/plan changes pause with less than $200 generation capacity left.
New generation requests stop when less than their $21 reservation remains;
rejected requests consume neither credits nor guest/daily allowances. Free and
internal usage also consume the global generation budget. Existing models and
subscription cancellation remain accessible. Never offer an upgrade as the
solution to a global capacity error.

Reservations reset by UTC calendar month. Tracking begins when the feature is
first enabled; it does not retroactively reimburse or cap prelaunch spending.
This is a conservative admission guard, not a guaranteed ceiling on provider
invoices: provider timing, month-crossing jobs, unreported external charges and
legacy AI paths can differ. Reconcile actual provider bills, including the
Anthropic daily reports. Review retained holds before adjusting them; never
release uncertain failed-job spend just because user credits were refunded.
A capacity pause does not cancel renewals or extend paid credit expiry. If a
pause materially affects paid service, provide a manual billing adjustment.

## Rollout

1. Verify the production merge is authorized. Apply only the unrecorded v2
   migration transactionally and record it. Keep `billing_settings.enabled=false`.
2. Run `backend/scripts/provision_billing.py --env-file <existing environment>`
   for sandbox resources, then `--live` for production. It creates immutable v2
   monthly prices and a cancellation portal, without charging anyone. Save each
   returned portal ID in the corresponding `billing_settings` column. Check that
   no active v1 subscription exists; expire any old open v1 subscription Checkout
   sessions and deactivate unused v1 prices before launch.
3. Deploy backend and frontend; verify both exact commit SHAs and the public
   `/billing/plans` prices and policy availability. Old API versions cannot admit
   metered generations after activation. Preserve existing Stripe keys and webhook
   signing secrets.
4. Extend the existing Stripe endpoint's events with
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`,
   and `checkout.session.async_payment_succeeded`, retaining existing events.
5. Validate sandbox Checkout, invoice replay, upgrade, refund and cancellation.
   Verify live catalog prices and portal settings without a live purchase.
   Then set `billing_settings.enabled=true` and verify anonymous Basic-only
   admission, signed-in balances, pricing, cancellation and capacity telemetry.

The wallet, ledger and budget reservations are service-only. Browser writes to
balances and generation status remain revoked. Subscription events fetch the
current Stripe state, validate owner/mode/price and apply paid invoices once.
Physical-kit webhook handling stays separate. A failed webhook returns an error
for Stripe retries; authenticated `/billing/sync` also reconciles on return.

For an incident, stopping new generation admission while retaining enforcement
is safer than disabling billing: set the generation budget to a small positive
value below existing usage. `enabled=false` restores unmetered legacy access and
3 guest attempts; it is a rollout rollback switch, not a spending kill switch.
Subscriptions still renew until canceled in Stripe. Keep the portal and webhook
service available for existing customers.

PostHog tracks pricing views, plan selection, checkout starts/failures, balance
and mode nudges, FAQ usage, confirmation and cancellation clicks. Stripe invoices
are the source of truth for paid revenue; client confirmation events are not.
