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
