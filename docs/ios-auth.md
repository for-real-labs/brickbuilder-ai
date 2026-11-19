# iPhone sign-in

Google sign-in remains available on the website. The iPhone app uses native
Apple authentication, email, and passkeys. Passkeys can be added in Dashboard →
Settings after signing in to an existing account.

## Apple setup

- Enable Sign in with Apple and Associated Domains for the BrickBuilder App ID,
  `ai.brickbuilder.app`, in Apple Developer. Rebuild with an updated provisioning
  profile containing both entitlements.
- In Supabase Auth, enable Apple and add `ai.brickbuilder.app` as an accepted native
  client ID. Keep nonce verification enabled.
- Apply `20261119030000_apple_sign_in_credentials.sql` before enabling Apple in the
  web frontend. Configure the backend with `APPLE_SIGN_IN_CLIENT_ID`,
  `APPLE_SIGN_IN_CLIENT_SECRET` (Apple client-secret JWT for the native App ID)
  and `APPLE_SIGN_IN_ENCRYPTION_KEY` (a dedicated Fernet key). Store and rotate
  the signing credentials outside Git. Keep the encryption key available to
  decrypt existing grants. The backend stores only encrypted refresh tokens,
  revokes the Apple grant on account deletion, and then deletes the local account.
- Set `VITE_APPLE_SIGN_IN_ENABLED=true` only after this setup.

## Passkey setup

- In Supabase Auth Passkeys, use RP ID `brickbuilder.ai`, display name
  `BrickBuilder`, and allowed origin `https://brickbuilder.ai`.
- Verify `https://brickbuilder.ai/.well-known/apple-app-site-association` serves
  JSON for team `F3M935826C` and bundle `ai.brickbuilder.app`. The entitlement
  is `webcredentials:brickbuilder.ai`.
- Set `VITE_PASSKEYS_ENABLED=true` after configuring the Auth project. The Supabase
  SDK uses its experimental passkey API.
- In a signed TestFlight build, test a new Apple account, a returning account,
  cancellation, account deletion and revocation, adding a passkey in Settings,
  and signing out and back in with the passkey. Check that an existing web Google
  account can still sign in with its email or a registered passkey.

After sign-in on a supported browser or iPhone, accounts without a passkey see
an optional setup prompt. Dismissing it suppresses the prompt in the current
browser or app installation. Dashboard → Settings still offers setup. Test
web registration and sign-in on the production RP origin and on any separately
configured test origin.

## Authenticator MFA

Dashboard → Settings lets users turn on MFA with an authenticator app. They
scan a QR code or enter the setup key, then confirm with a six-digit code. Users
can add a second authenticator in Settings. First-factor sessions require an
authenticator code before account access.

- Apply `20261119040000_account_mfa_enforcement.sql` to the Auth project and deploy
  the updated `change-request` function. The migration adds restrictive MFA
  policies to existing public and Storage tables that have RLS. Apply the same
  assurance policy when adding future tables with account data.
- Enable TOTP enrollment and verification in Supabase Auth. Deploy the backend
  with `AUTH_MFA_ENFORCEMENT_ENABLED=true`, then deploy the frontend with
  `VITE_MFA_ENABLED=true`.
- Test initial enrollment, sign-out, signing in with and without a verified
  factor, and removing the last authenticator. Check that the API and Supabase
  reject an enrolled user's first-factor session.
