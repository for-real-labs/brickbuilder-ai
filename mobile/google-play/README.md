# Google Play release

Package: `ai.brickbuilder.app`. This is the existing Expo mobile app, using
the same deployed BrickBuilder features as iOS.

## Listing assets

`metadata/en-US/` contains the title, short description, full description,
and initial release notes. The full description matches the published iOS
1.0.1 description, including the LEGO trademark notice. The description and
three screenshots were verified against the [public App Store listing](https://apps.apple.com/us/app/brickbuilder-ai/id6815050463)
on October 17, 2026, after App Store Connect requested sign-in. The Play icon
uses the current native app icon, including the concurrent Pip icon update.

Upload `graphics/icon.png` (512 × 512), `graphics/feature-graphic.png`
(1024 × 500), and the three numbered files in `graphics/phone/`, in order.
Phone artwork reuses the iOS marketing screenshots with padding to meet
Google's 9:16 aspect ratio; it does not crop or stretch the app UI. The feature
graphic reuses the original model render, font, colors, and headline.

Rebuild and validate:

```sh
uv run --with pillow --with numpy python mobile/app-store/design/render_google_play.py
uv run --with pillow --with numpy python -m unittest discover -s mobile/app-store/design/tests -v
cd mobile
npm test
npm run typecheck
```

Support: `support@brickbuilder.ai`. Website: `https://brickbuilder.ai`.
Privacy policy: `https://brickbuilder.ai/privacy`.
The privacy policy includes the account-deletion request process.

## Build and submission

Run from `mobile/`:

```sh
npx eas-cli@latest build --platform android --profile production
```

The production profile creates a signed Android App Bundle (`.aab`) with an
automatically incremented remote version code. Expo manages the Android
upload keystore. Do not commit or publish keystores or service-account keys.
The Expo SDK 57 / React Native toolchain targets Android API 36.

Initial release build: [Expo Android production build](https://expo.dev/accounts/jakesessiongalaxys-team/projects/brickbuilder/builds/2b62562d-60d7-4568-92fa-93becf3d340e),
version `1.0.2`, version code `4`. Check the linked build's status before using
its download; starting a build is not confirmation that it succeeded.

Download the successful build's `.aab`, create or open the app in the correct
Google Play developer account, upload the bundle, and finish the listing and
app-content forms. Confirm data-safety answers from the actual app behavior
and privacy policy, including account data, uploaded images/prompts, analytics,
AI processing, and physical-goods orders. Rating, audience, app access, and
production eligibility must be completed in that account before submission.

The release PR adds **Report model** on generated-model pages, including guest
access, using the existing feedback service. It includes only the model ID
from the page query, excluding authentication tokens and other query data.
Deploy this frontend change before Google review; the native app loads the
hosted frontend, so the control does not require a new Android bundle.
Google requires [in-app reporting for AI-generated content](https://support.google.com/googleplay/android-developer/answer/13985936?hl=en).

On October 17, 2026, `jake@brickbuilder.ai` opened developer-account
registration rather than an existing Play Console. Submission is pending access to the intended developer
account; no Play app or review submission has been created yet.

Google may require developer verification and, for newer personal accounts,
a closed test before granting production access. Do not represent a testing
release or an uploaded bundle as a public launch.

References: [Google asset requirements](https://support.google.com/googleplay/android-developer/answer/9866151?hl=en),
[Expo manual upload](https://docs.expo.dev/submit/android-manual/),
[Google personal-account testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en).
