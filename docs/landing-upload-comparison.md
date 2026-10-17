# Image upload placement comparison

## Baseline

Verified in PostHog project [332024](https://us.posthog.com/project/332024)
using the exact UTC window **October 10, 2026, 13:05:00 inclusive through
October 17, 2026, 13:05:00 exclusive**. Filters: production hosts
`brickbuilder.ai` and `www.brickbuilder.ai`, and `$pathname = '/'`.

| Metric | Below-input labeled button |
| --- | ---: |
| Unique homepage visitors (`$pageview`, distinct `person_id`) | 431 |
| Homepage pageviews | 1,249 |
| Unique people opening the image picker | 138 |
| Picker opens (`landing_image_picker_opened`) | 393 |
| Unique clickers / homepage visitors | 32.02% |

The homepage's old picker control was the labeled button below the prompt.
Those events have no `upload_position` property. This baseline is a historical
snapshot; it is not a measurement of the new icon.

## New placement and events

The upload icon is inside the prompt input on its left, with a 44px hit target,
an accessible `Upload image` name and tooltip, keyboard access, and the same
file picker and busy-state behavior. It does not submit the generation form.

- `landing_image_upload_control_shown` records exposure to the new control with
  `upload_position: 'input_left_icon'` and the existing `page` convention.
- `landing_image_picker_opened` retains its name and adds `upload_position`.
  `input_left_icon` identifies the relocated button; `image_upload_section`
  identifies the separate upload area on image-specific landing pages.
- Continue filtering every comparison to the live homepage. Do not include
  drag-and-drop uploads, other landing pages, or selected files as picker clicks.
  Opening then canceling the picker still counts as a button click.

## Scheduled report

A one-time local Codex CLI session is registered through macOS launchd for
**October 24, 2026, at 9:20 AM America/Chicago**, with delivery to
**jake@brickbuilder.ai**. Its saved prompt, logs and results are in
`~/.codex/scheduled-reports/brickbuilder-20261024/` alongside the Tools report.
The Mac must be on with the user logged in. The launch agent checks for a
missed run at login and every 15 minutes, attempts the report once, then removes
its own launch agent. It does not automatically resend after an ambiguous or
failed email attempt. The report must confirm Gmail delivery or state failure.

Launch-agent label: `ai.brickbuilder.codex-report-upload-20261024`.

The session will locate rollout using the first production exposure event,
compare seven complete post-rollout days when available, and report total
clicks, unique clickers, visitor-normalized rates, exposure coverage and
percentage-point changes. If fewer days are available or the change has not
been deployed, it will email an honest partial-data/status report on the
scheduled date. Recommendations must acknowledge the small sample and other
landing-page changes made at the same time. No deployment or code changes
are authorized by the reporting task.
