# Monthly credits and subscriptions

Apple iOS purchases and their non-expiring credit balance are described in
[Apple subscriptions release](apple-subscriptions.md). The Stripe expiry rules
below apply to web purchases. Apple launch requires a new binary and App Store configuration.

## Launch state

Monthly billing is enabled in production. Both `20261022000000` and
`20261023000000_billing_pricing_v2.sql` are already recorded; do not reapply them.
The guest allowance update requires `20261023020000_guest_credit_allowance.sql`,
followed by `20261023030000_generation_retry_guard.sql` for retry protection;
the paid-feature locks themselves need no new schema. Re-run the catalog provisioner
when deploying it so Stripe's billing portal offers only Builder and Creator.
Existing Master Builder subscriptions keep their allowance, renewal and cancellation
support; Master Builder is no longer offered for a new checkout or plan change.

## Plans

| Plan | USD / month | Monthly credits | Example use of the shared balance |
| --- | ---: | ---: | --- |
| Free | $0 | 300 | 300 Basic or 20 All parts builds |
| Builder | $9 | 500 | 500 Basic or 33 All parts builds, with 5 credits left |
| Creator | $19 | 750 | 750 Basic or 50 All parts builds |

Basic generation and Basic AI edits cost 1 credit. All parts generation/edits and
AI text/image-to-mesh conversions cost 15 credits on every plan, including Free. Modes
share a balance; the example counts are alternatives, not additive allowances.
Monthly plans only; no annual plans or one-off packs. Physical kits are separate.

Free includes model creation, 3D previews, CSV/XML parts lists and instructions for
the account's ordered kits. A non-cancelled order linked to an authenticated account's
exact generation unlocks that model's instructions, including fulfilled orders.
It does not unlock other versions/models or LDR/IO exports, and does not depend on
remaining credits or subscription status. This uses the same order ownership as My Orders.
LDR/IO exports and instructions for other models require Builder or Creator (or an existing Master
subscription). The options remain visible with a lock and open the shared
BrickBuilder upgrade notice. The notice leads to the existing plan picker.
Direct instruction links, postcard previews and Build Buddy export actions use the same access check.
A paid account keeps these features through its paid period, even with zero credits
or cancellation scheduled. Unknown account state does not unlock a feature.

The Nova instructions endpoint checks the requesting account's model order or paid period and uses
private, non-cacheable responses. Display geometry still reaches the browser for
3D previews: these are app feature restrictions, not DRM for already-public model data.

Paid kit checkouts also issue a random 256-bit key per order, including guest
orders. The same `/instructions?id=…#access=…` link is sent in the customer
confirmation and fulfillment email. The fulfillment email's `/order?id=…#access=…`
link opens the correct postcard preview with that key encoded in its QR.
Only a SHA-256 hash is saved in `orders.instructions_key_hash`; raw links are
retained in the delivery emails, not generation rows or shipping metadata.
The browser removes the fragment before analytics starts and keeps the key in
tab session storage. It is sent only in the `X-Instruction-Key` header to
instruction endpoints. QR elements are excluded from automatic analytics and replay.
Keys have no automatic expiry because a printed postcard should remain usable.
Cancellation or clearing/replacing the hash revokes the link. Keys do not grant
editing, exports, order details, or access to another model/version.

Apply `20261024000000_order_instruction_keys.sql` before deploying the backend.
For an older guest order, run
`uv run python scripts/issue_order_instruction_link.py <order-id>` from `backend`
in an environment with its existing database credentials.
Deliver the returned instructions link to the buyer and use its postcard link
for fulfillment. This command does not send emails or change an existing link;
`--replace` explicitly invalidates an older link, including any printed QR.
Do not paste keys in public tickets/logs. No historical emails are resent automatically.

Hosted guests get 75 lifetime credits without signing in: 5 All parts builds or
75 Basic builds, or a mix. Basic AI edits use 1 and All parts/AI mesh work uses 15.
Browser and network balances are reserved atomically and never reset monthly,
on sign-in, or when a model is deleted. Failed/canceled jobs return guest credits
exactly once; provider spend is never refunded by that credit return. A rejected
expensive build leaves remaining credits available for Basic. Imports, manual
edits, resizing and parts lists consume no guest credits.

The migration preserves known model weights and historical attempts. Historical
attempts whose mode is no longer available (deleted/claimed models and IP counters)
retain one credit each; network hashes were not stored on models. New charges
privately record both identities for exact refunds. Shared Wi-Fi users share the
network allowance. Changing both browser and network can still obtain another
trial; anonymous usage cannot establish a person's identity.

Guest builds claimed after sign-in count toward that month's Free allowance at
their 1/15-credit weight, capped by the remaining Free balance. Failed trials and
old-month builds do not deduct new monthly credits. The default daily guest cap
is bypassed while billing is enabled so the 75-credit allowance is usable; short
request throttles, one active generation and the global spending guard remain.
Monthly credits also replace the default daily cap for signed-in accounts.
Explicit signed-in account restrictions and verified owner exemptions remain.

After five failed/canceled AI attempts within a rolling 24 hours, new
BrickBuilder-funded builds pause until fewer than five remain in that window.
This applies to Free, paid and internal accounts, plus each guest browser and
network. Failed/canceled jobs still refund credits; upgrades, wallet resets and
model deletion do not clear the pause. Claimed guest models carry their history
to the signed-in account. Personal API-key work, imports and manual tools do not
consume retry slots and stay available. Cancellation remains available throughout.

The private retry ledger reserves slots for in-flight builds as well, limiting
parallel requests to the remaining slots. Successful completion releases a slot;
deleting an unfinished build records a failed attempt. Repeated status updates
cannot add strikes or extend an existing one. Old unfinished reservations expire
from this guard after 24 hours; the separate active-job limit still applies.
Pre-admission validation/quota/capacity rejections leave no retry charge. Once an
AI job is admitted, an unsuccessful outcome counts conservatively because provider
spend may be incomplete or unknown. Historical failures use the original admission
time when the terminal time cannot be established (or migration time if both are
missing). Separate accounts and changing
both guest browser and network remain distinct identities; the global spend guard
is still required. The embedded local development store does not run this migration.

The 31,700 prelaunch bonus credits are preserved. Users can redeem up to 5 per
UTC calendar month, after monthly credits, for Basic builds only. They never
expire. The account page separates the full legacy balance from credits usable
this month. Monthly credits fund either mode; legacy bonuses remain Basic-only.

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

With the revised 300-credit Free allowance, 79 of the 89 signed-in builders
(89%) fit entirely within Free at their observed mix of Basic and All parts.
Ten exceeded 300 weighted credits; seven exceeded 500, six exceeded 750 and five
exceeded 1,000. Historical usage therefore provides little reason for most of
this cohort to upgrade. The larger free plan is a subsidized acquisition offer,
not evidence that more users will subscribe.

The historical prelaunch model below included Master Builder; it is not a forecast
of conversion after adding paid exports and instructions. Keeping those earlier
illustrative assumptions (65% of Generate clickers active,
2% subscribing, 60/30/10% paid-plan mix, 70% paid-credit utilization, $0.25 per
weighted credit, two free weighted credits used per active free user, and a
$500 reserve) gives the following *unconstrained demand*, before budget pauses:

| Generate audience | Expected subscribers | Gross MRR | Monthly AI demand |
| --- | ---: | ---: | ---: |
| 1× (901 people) | 18 | $270 | $2,755 |
| 1.5× | 27 | $405 | $3,882 |
| 2× | 36 | $541 | $5,010 |
| 3× | 54 | $811 | $7,264 |

That earlier model used a paid allowance average of 625 credits. At 1.5× traffic, increasing
average free use from 2 to 20 weighted credits raises the modeled demand to
$7,714/month. A fully used Free allowance costs about $60–$63 at the recorded
mode averages, or $75 at the conservative planning rate. Twenty fully used Free
allowances alone would consume the $1,500 generation budget at that planning
rate, before any paid use. Legacy bonus redemption is additional: all 317
legacy accounts redeeming five extra credits adds about $396/month.

The prior 20–40% active-user, 60–80% total-build and 90–98% All parts drop-off
estimates assumed a five-Basic-only Free plan and no longer apply. Allowances do
not identify willingness to pay or usage after a paywall. The newer 75-credit guest trial and paid export/instruction locks are not included
in this historical model. Most observed signed-in users can keep their existing
generation habits free; heavy users, guest sign-in friction,
and capacity pauses will drive any drop-off. At the 1.5× scenario, $1,500 of
generation capacity covers about 44% of the modeled $3,382 generation demand
(before the $500 reserve), implying roughly 56% of weighted usage must be
unserved if that demand materializes at the planning cost. This is a capacity
scenario, not a prediction of voluntary churn or of the number of builds.

These assumptions are not a measured conversion forecast. Full utilization and
growth cannot be served within the current budget; the guard will pause service
before everyone uses their advertised allowance. Do not present this pricing as
self-funding or promise uninterrupted availability. Measure conversion, renewal,
cancellations, generation mix, actual spend and capacity rejections after launch.

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

1. Verify the production merge is authorized. On an existing installation, do
   not reapply recorded migrations or reset wallets. Keep the current billing
   setting. Deploy the backend that recognizes guest-credit errors, then apply
   only the unrecorded guest-credit and retry-guard migrations in order,
   transactionally, and record them.
2. Run `backend/scripts/provision_billing.py --env-file <existing environment>`
   for sandbox resources, then `--live` during the authorized production rollout.
   It reuses the existing Builder/Creator v3 prices and updates the portal to offer
   those two plans with cancellation still enabled. Verify the returned portal IDs
   against `billing_settings`. Keep retired prices available for existing invoice
   reconciliation; expire any open Master Checkout sessions after removing that
   option from the app. The database admission policy remains version 2.
3. Deploy the frontend after the backend and both new migrations are ready;
   verify both backend and frontend commit SHAs before advertising the allowance.
   Confirm `/billing/plans` returns `ready=true` and only Free, Builder and Creator;
   `/billing/account` must include `paid_features`. Preserve existing Stripe keys,
   webhook events, signing secrets and billing enablement.
4. Verify Free export/instruction controls show locks and the upgrade notice,
   direct instruction links cannot load steps, and paid access remains available
   with zero credits or cancellation scheduled. Check desktop and mobile layouts.
5. Validate sandbox Checkout, existing subscription reconciliation and cancellation.
   Verify live catalog prices and portal choices without a live purchase. Check
   five guest All parts builds / 75 Basic builds, mixed use, refunds, retry pauses,
   the localized retry time, the three signed-in balances and capacity telemetry;
   never reset wallets or
   reapply the previously recorded allowance migration during this rollout.

The wallet, ledger and budget reservations are service-only. Browser writes to
balances and generation status remain revoked. Subscription events fetch the
current Stripe state, validate owner/mode/price and apply paid invoices once.
Physical-kit webhook handling stays separate. A failed webhook returns an error
for Stripe retries; authenticated `/billing/sync` also reconciles on return.

For an incident, stopping new generation admission while retaining enforcement
is safer than disabling billing: set the generation budget to a small positive
value below existing usage. `enabled=false` restores unmetered signed-in access
and the default daily cap; the hosted 75-credit lifetime guest limit remains.
This is a billing rollback switch, not a spending kill switch.
Subscriptions still renew until canceled in Stripe. Keep the portal and webhook
service available for existing customers.

PostHog tracks pricing views, plan selection, checkout starts/failures, balance
and mode nudges, FAQ usage, confirmation and cancellation clicks. Server-side
`request_limit_hit` events distinguish `generation_retry_cooldown` and
`generation_retry_pending` without sending network hashes or prompts. Stripe invoices
are the source of truth for paid revenue; client confirmation events are not.
