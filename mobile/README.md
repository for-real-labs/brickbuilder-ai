# BrickBuilder mobile (Expo, iOS-first)

This is a deliberately thin Expo shell around the production BrickBuilder web
app. The generation form, generation/model view, order flow, dashboard, and
block editor all run from the existing React web code. The mobile project adds
only native presentation concerns:

- iOS safe-area and status-bar handling
- a small native Create / Dashboard / Back / Reload toolbar
- an allowlisted Request an app change control backed by the web flow
- persistent web authentication and browser storage
- image/file upload support through the system picker
- WebGL support for the model viewer and block editor
- external-link safety, loading/error states, and offline feedback

There is no duplicated generation, ordering, authentication, or editing
business logic. Deploying the web app updates those features for both web and
mobile users.

Google OAuth is hidden inside the native shell. The existing email-code flow is
used instead, because Google blocks many embedded browser sign-ins and offering
a third-party login on iOS can require Sign in with Apple. Google remains
available on the normal website.

## Run locally

Use Node 22.13 or newer (an even-numbered Node release supported by the current
React Native toolchain).

```sh
cd mobile
npm install
npm test
npm run typecheck
npm run ios
```

The default URL is `https://brickbuilder.ai`. To test another HTTPS deployment,
copy `.env.example` to `.env.local` and change `EXPO_PUBLIC_WEB_APP_URL`.
`http://localhost:<port>` is also accepted for an iOS Simulator.

Because this app includes native modules, use an iOS Simulator/development
build or Expo Go. A production EAS build does not depend on a locally running
web server.

## EAS and TestFlight

The profiles mirror the setup used by Session Galaxy:

- `development`: development client for devices
- `preview`: internal iOS Simulator build
- `feedback`: exact-commit App Store build used by the change-request workflow
- `production`: signed App Store build with an auto-incremented build number

One-time setup:

1. Confirm that `ai.brickbuilder.app` in `app.json` is the bundle identifier
   registered in your Apple Developer and App Store Connect accounts. Change it
   before the first release if you prefer a different identifier.
2. Install and authenticate EAS CLI: `npm install -g eas-cli && eas login`.
3. Confirm the existing EAS project ID in `app.json` is available to the Expo
   account that will build the app.
4. Create the app record in App Store Connect with the same bundle identifier.

Build and submit:

```sh
cd mobile
eas build --platform ios --profile production
eas submit --platform ios --latest
```

EAS can manage the distribution certificate and provisioning profile. The
submitted build appears in TestFlight after Apple finishes processing it.

## In-app change requests

For signed-in users on the private change-request allowlist, the native toolbar
shows **Change**. It opens the same React form and Supabase Edge Function used
by the website; the native app does not duplicate submission or approval
logic.

An iOS request starts Copilot on a branch from `staging`. When the pull request
is complete, GitHub Actions waits for the matching Vercel preview, builds an
Expo binary that embeds that exact branch, submits it to the configured
TestFlight internal group, and emails the requester only after Apple reports
the build as available. The build carries the request ID, branch, and commit
SHA so approval and revision requests are checked against the artifact being
tested.

Repository configuration for that automation:

- Secret `EXPO_TOKEN`: Expo personal access token for the project owner.
- Variable `TESTFLIGHT_GROUP`: App Store Connect internal group name, such as
  `Team (Expo)`.
- Secret `CHANGE_REQUEST_EVENT_SECRET`: shared with the Supabase Edge Function.

The Edge Function also needs `CHANGE_REQUEST_TESTFLIGHT_URL`, set to the app's
TestFlight invitation URL. See `docs/feedback-agent-flow.md` for deployment
order and database migration details.

Before production review, complete App Store Connect's privacy questionnaire
for uploaded images, account data, purchases, and analytics; add support and
privacy-policy URLs; and provide a review account or explain the email-code
login flow in the review notes. Since the app renders server-hosted features,
keep `https://brickbuilder.ai` available during review.

## App Store media (Pip refresh)

`app-store/review.html` presents the three connected screenshots, the iPhone and
iPad preview videos, wallpaper concepts, and the white Pip app icon. Open it
locally or serve this `mobile/` directory on localhost. Each screenshot set has
exactly three RGB portrait PNGs; ZIP files preserve their upload order.

The screenshots use original pet artwork, three fal.ai wallpaper concepts,
and captures of the production app on iPhone 16 Pro and iPad Pro 13-inch.
`app-store/design/capture-manifest.json` records capture provenance. The iPad
model still is frame 35 of the original simulator recording. Source recordings
remain in the local `brickbuilder-app-store-pip/raw` artifact directory; the
trimmed capture clips are included under `app-store/video/sources/`.

The two App Store videos are 24 seconds, H.264 High Level 4.0, progressive,
30 fps, with stereo AAC at 48 kHz. The iPhone export is 886 × 1920; iPad is
1200 × 1600. They use actual app captures, explanatory text, and original music
created on fal.ai. Idle shots hold their last captured frame when the simulator
stops producing frames. Example prompts are typed without submitting a build
or edit. The separate five-second fal.ai Pip welcome clip is supplied as a
mascot asset; it is not uploaded as the App Store preview.

`app-store/design/generation-ledger.json` records requests and spending: about
$1.33 of the authorized $100 budget. Existing pet media was reused without
additional generation charges. The icon uses the original high-resolution Pip
art, centered on an opaque white 1024 × 1024 canvas.

Regenerate with Python, Pillow, and numpy:

```sh
python app-store/design/icon.py
python app-store/design/render.py
python app-store/video/encode.py
python -m unittest discover -s app-store/design/tests
python -m unittest discover -s app-store/video/tests
```

The prepared App Store Connect version is **1.0.2 (4)**. Its screenshots, videos,
and listing copy are uploaded, and the processed build includes the Pip icon.
**Do not submit this version for review until Jake explicitly approves it.**
The verification snapshot is in `app-store/proof/app-store-draft.json`.
