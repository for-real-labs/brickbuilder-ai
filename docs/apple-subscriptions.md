# Apple subscriptions release

This change adds StoreKit purchases to the Expo iOS shell. It must ship in a new
App Store binary; deploying the web frontend alone cannot add StoreKit to existing
installations. The frontend disables digital web checkout in older iOS shells and
asks users to update. Physical brick orders retain their separate Stripe checkout.

## Catalog in App Store Connect

App: **BrickBuilder**, Apple ID **6815050463**, bundle **ai.brickbuilder.app**.
Create one auto-renewable subscription group, **BrickBuilder**, with these products:

| Product ID | Display name | Duration | US base price | Credits per renewal |
| --- | --- | --- | --- | --- |
| ai.brickbuilder.app.builder.monthly | Builder | 1 month | $9.00 | 500 |
| ai.brickbuilder.app.creator.monthly | Creator | 1 month | $19.00 | 750 |

Creator is level 1 and Builder level 2 in the same subscription group. Do not enable
Family Sharing, introductory trials, or offer codes for this implementation. Store
prices come from StoreKit, including local currency; the server never trusts a
client price or credit allowance. Apple confirms charges and plan changes.

Complete each product's localization, review screenshot, tax category, availability,
and review information. Confirm Paid Apps agreements, banking and tax details are
active. Add the products to the new app version for their first review. Put the
Terms of Use URL (`https://brickbuilder.ai/terms`) in the app description and keep
the Privacy Policy URL (`https://brickbuilder.ai/privacy`) configured.

## Backend setup

Apply `20261024000000_apple_subscriptions.sql` after existing migrations, once.
Deploy the backend before the frontend. Configure these server-only settings:

- `APPLE_IAP_ENABLED=true` only after configuring and testing the catalog.
- `APPLE_APP_ID=6815050463`.
- `APPLE_IAP_KEY_ID`, `APPLE_IAP_ISSUER_ID`, `APPLE_IAP_PRIVATE_KEY`: the Apple
  In-App Purchase server API signing key (PEM with actual newlines). Never put
  the private key in Expo public variables or the browser bundle.
- `APPLE_ROOT_CERTIFICATES_DIR`: directory of Apple's DER `.cer` root certificates
  downloaded from [Apple PKI](https://www.apple.com/certificateauthority/).
  Verification uses Apple's official server library with online certificate checks.
- `APPLE_SANDBOX_REVIEW_USER_IDS`: optional comma-separated UUIDs of dedicated
  BrickBuilder App Review/TestFlight accounts. Production falls back to Apple's
  sandbox only on Apple's transaction-not-found response, and only these verified
  account tokens may receive sandbox entitlements. Do not list normal customer
  accounts. Sandbox and production transaction identifiers are separately namespaced.
  A non-production backend uses only Apple's sandbox and its test wallet.

Configure **App Store Server Notifications V2** for production and sandbox:
`https://<API-host>/billing/apple/notifications`. For a production App Review build,
use the production notification endpoint for sandbox too and designate its review
accounts above. Notifications are signature-verified, then current transaction
state is fetched from Apple. Set up monitoring for non-2xx responses and use Apple's
notification history recovery after a prolonged outage. Authenticated restore/sync
also scans paginated transaction history to recover missed renewal grants/refunds.
Apple API and certificate-check outages leave transactions unfinished for retry.

The shared wallet has a separate non-expiring Apple balance. Overlapping upgrade periods grant only the positive allowance difference; repeated
plan switches cannot mint extra monthly grants. Apple grants cannot be
replayed, ownership cannot be reassigned, and old messages cannot overwrite newer
transaction states. Free monthly grants pause while an Apple subscription is active.
Paid Apple features expire with the verified paid period; purchased credits remain
usable for generation after cancellation. Billing-retry periods do not extend paid
features without a new paid transaction; leave Billing Grace Period disabled until
explicit grace-period entitlement handling is implemented.

Generation consumes expiring monthly credits first, then Apple credits, then eligible
legacy bonuses. A mixed charge records its Apple share and refunds that share even
after the monthly period changes. Apple purchase refunds remove the original grant;
if those credits were already spent, the Apple bucket retains debt against future
grants. Refund reversals restore the grant once. Existing Stripe plans retain their
own expiry rules. The UI and API block ordinary cross-provider double subscriptions;
a simultaneous payment or external App Store change can still produce subscriptions
at both providers and requires support to reconcile billing.

## Build and review

1. Use a supported Node version (22.13+ or another Expo-supported even release),
   install mobile dependencies, and run mobile tests/typecheck. `expo-iap` is a native
   module: use a development build, not Expo Go. Rebuild after installing it.
2. Build a new production iOS version with EAS; do not reuse the old binary. Use
   `eas build --platform ios --profile production`, then submit that exact build to
   TestFlight. Backend/frontend releases must be live before testing that build.
3. Test on an iPhone and iPad with dedicated accounts: purchase each plan, cancel
   the purchase sheet, Ask to Buy/pending approval, restore after reinstall,
   sign out/in, switch BrickBuilder accounts, kill the app after payment before
   delivery, renew, upgrade/downgrade, cancel at period end, refund and refund reversal.
   Confirm localized prices, no Stripe digital checkout, and access with zero credits.
4. Send a test V2 notification and confirm processing. Verify duplicate/out-of-order
   notifications, failed verification, and temporary API outages do not grant twice
   or finish a purchase before the server persists credits.
5. Provide the designated review account and login instructions. Explain where to
   find plans, Restore purchases and Manage Apple subscription, that purchased Apple
   credits never expire, and that physical brick kits use a separate checkout.
6. Submit the new binary and both subscription products for review. An App Store
   approval cannot be guaranteed by code or automated tests.

The code and migration are prepared separately from live configuration. A passing
unit suite is not proof of a successful sandbox purchase, deployment, or App Review.

References: [Apple review guidelines, 3.1.1–3.1.2](https://developer.apple.com/app-store/review/guidelines/),
[Apple In-App Purchase](https://developer.apple.com/in-app-purchase/),
[Apple server library](https://github.com/apple/app-store-server-library-python),
[Expo IAP](https://hyochan.github.io/expo-iap/).
