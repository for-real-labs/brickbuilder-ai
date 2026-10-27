# One-time credits

Web packs: 800 credits for $10.80 or 1,500 for $22.80 (USD), exactly 20% above
matching monthly plans. Apple uses its nearest price points: $10.90 and $22.90
in the US, with localized prices returned by StoreKit.

Packs never expire, do not change subscriptions, and do not unlock paid features.
Free accounts are welcome to purchase packs. The exhausted-credit prompt sends
Free users to pricing, Builder users to upgrades, and Creator/legacy Master users
to the credit-pack section. Personal API-key settings remain separately available.

Apply `20261027010000_credit_packs.sql` before deploying. It adds a private purchase
ledger and reuses the non-expiring wallet bucket historically named
`apple_remaining`. Existing atomic spending and failed-build refund rules apply.
Verified payments grant exactly once. Purchase refunds reduce the grant, retaining
debt if already spent; refund reversals restore it once. Stripe partial refunds
remove a proportional number of credits, rounded up. Purchased credits are spent
after monthly credits and before legacy bonuses.

Stripe uses server-owned Checkout price data with the `brickbuilder_credit_pack_v1`
metadata tag. Add `charge.refunded`, `charge.dispute.created`, and
`charge.dispute.closed` to the existing billing webhook. Existing checkout success
events deliver purchases even if the customer never returns to the app.

Apple products (consumable, no Family Sharing):
- `ai.brickbuilder.app.credits.800`, Apple ID `6827673740`
- `ai.brickbuilder.app.credits.1500`, Apple ID `6827673911`

Apple transactions require verified signatures, the correct bundle/environment,
account token ownership, and quantity one. The app finishes consumables only after
server persistence, and replays unfinished StoreKit transactions on login/relaunch.
Credits already delivered remain in the account after reinstall; consumables are
not restorable StoreKit subscription entitlements. Existing subscription restore
still works. Apple refunds arrive through the existing signed server notifications.

Version 1.0.5 is prepared in App Store Connect with automatic release after approval.
Both product records have US pricing, regional availability, and English metadata.
App Review screenshots, a validated build, native purchase tests, and submission
must be verified separately before claiming Apple availability. Old binaries never
offer these product IDs and display an update notice instead of web checkout.

## Release verification — October 27, 2026

Implementation commits: `7571173`, followed by Stripe dispute API compatibility
fix `5c4df56`, pushed to main at the user's explicit request. Production migration
`20261027010000` is applied and recorded. Stripe's existing webhook now includes
refund and dispute events. Both live Checkout amounts were verified using the
existing review account, unpaid sessions granted no credits, and both sessions
were expired without charges. GitHub's full Test suite passed for `5c4df56`.
Local checks included 1,252 frontend tests, the frontend build, 1,720 backend tests
(69.67% coverage), the additional dispute regression, 27 mobile tests, mobile type
checking, 35 root tests, and nine agent-configuration tests. Pricing layouts were
inspected at 390px and 1440px widths.

App Store version ID: `1ac32df1-0878-4500-86dd-ca024630d58d` (1.0.5,
`AFTER_APPROVAL`, Prepare for Submission). English release notes and review notes
are saved; existing review login is retained. Both consumables have localized
names/descriptions, all-territory availability, and verified US prices $10.90 and
$22.90. They remain Missing Metadata pending review screenshots and submission.

No new binary was uploaded or submitted. EAS cloud builds were blocked by the
organization's exhausted free iOS quota until November 1. Local build setup passed
signing after installing Apple's official WWDR G3 intermediate, but was stopped
during CocoaPods installation when free disk space fell below 1 GB. Temporary
build cleanup restored roughly 1.9 GB; this is still insufficient for a native
archive. Native sandbox purchases and App Review submission remain unverified.
Resume with cloud build capacity or sufficient local disk space, run native
purchase tests, capture review screenshots, upload/attach the validated 1.0.5
binary, and submit that version together with both first-time consumables.

### New Expo account project

At the user's request, created `@jjohnson5253/brickbuilder` under their Gmail
Expo account instead of transferring the old organization project. New EAS
project ID: `92d07dc7-90af-4583-8894-0a2df516b467`. The Apple bundle identifier
and App Store app remain unchanged. New distribution signing credentials were
configured successfully for the existing Apple team. No EAS Update configuration
was present to migrate. Mobile type checking and all 27 mobile tests passed.

Version 1.0.5 build 22 was accepted into the cloud build queue:
`cb39ed6b-e1d0-45bb-a836-7ddd50523daa`. This supersedes the old account's quota
blocker; build completion, native purchase validation, and Apple submission are
still pending.
