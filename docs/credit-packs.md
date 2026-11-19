# One-time credits

An active paid monthly plan is required to buy credits. The web and current iOS
catalogs offer the same one-time pack sizes. Prices below are for the U.S.

| Credits | Price | Premium over the Builder subscription rate | Savings per credit vs. the smallest pack |
| ---: | ---: | ---: | ---: |
| 115 | $1.99 | 30% | |
| 626 | $9.99 | 20% | 8% |
| 1,367 | $19.99 | 10% | 15% |

The picker shows StoreKit’s localized price and calculates savings from local
prices on iOS. On the web, Stripe checkout accepts a pack key and the server
sets the price and credit count. Pricing and Billing both use the same picker.
Purchased credits never expire and remain available after a subscription ends.

Apply `20261119010000_tiered_credit_packs.sql` before deploying the backend,
then deploy the updated frontend. In-flight custom Stripe purchases and
historical receipts and refunds still reconcile using the original catalog or
the versioned quote from `20261102010000_custom_credit_purchases.sql`.

For iOS, create and submit the three consumables below, using the U.S. prices
above and the appropriate localized prices. Release a native build with the
updated purchase bridge. Test product loading and each grant in TestFlight
before releasing. Older binaries continue to work with the legacy Apple
products while those are available. Keep the old IDs in the server and native
transaction allowlists for unfinished purchases and refunds.

- `ai.brickbuilder.app.credits.115`
- `ai.brickbuilder.app.credits.626`
- `ai.brickbuilder.app.credits.1367`

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

Legacy Apple products (consumable, no Family Sharing):
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

### Verified Apple submission — October 27, 2026

Version 1.0.5 build 22 finished, uploaded, passed Apple processing (`VALID`), and
was attached to the version. The user supplied native TestFlight screenshots of
both purchase sheets and a successful purchase. Production's purchase ledger
confirmed both sandbox purchases granted exactly 800 and 1,500 credits. The clear
purchase-screen screenshot was resized from its chat-compressed dimensions to
1320 × 2868 for Apple review; both product screenshots processed successfully.

Review submission `b2ff6a99-6817-4f09-b5d2-1cb3ad03da95` was submitted at
2026-10-27 22:48:53 UTC. Independent reads confirmed **WAITING_FOR_REVIEW** for
app version `1ac32df1-0878-4500-86dd-ca024630d58d` and both consumable versions
(`f507dd43-4c88-45a9-a9d1-a4facfc4cf3d`,
`64d16608-74e9-414a-bb57-8618a02674e7`). Release remains **AFTER_APPROVAL**.
No further developer action is pending unless Apple requests changes.
