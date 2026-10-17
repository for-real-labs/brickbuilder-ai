# Landing-page Tools comparison

## Baseline

Observed in PostHog project [332024](https://us.posthog.com/project/332024),
on October 17, 2026, over the preceding rolling seven days. Filters:
`$host IN ('brickbuilder.ai', 'www.brickbuilder.ai')`, `$pathname = '/'`.
The denominator is distinct `person_id` on `$pageview`: **428 people**.

| Header destination | Unique clickers | Share of homepage visitors |
| --- | ---: | ---: |
| Image to LEGO | 47 | 10.98% |
| GLB to LEGO | 14 | 3.27% |
| Upload LDraw | 9 | 2.10% |
| Community | 12 | 2.80% |

Image and LDraw used `landing_header_image_to_lego_clicked` and
`landing_header_upload_ldraw_clicked`. GLB and Community used `$autocapture`,
`$event_type = 'click'`, and exact `$el_text` of `GLB to LEGO` or `Community`.
OBJ had no baseline in the original analysis. The baseline was a rolling window,
not an archived export; use these recorded counts as the historical snapshot.

## Dropdown instrumentation

All events include `page` and `navigation_layout: 'tools_dropdown'`:

- `landing_header_tools_shown`: header mounted; use its first production event
  to locate rollout, and unique people to check coverage against page views.
- `landing_header_tools_opened`: a visitor opens Tools.
- `landing_header_tools_item_clicked`: a visitor chooses a link, with `tool`
  and `destination`. Use this event for dropdown click counts.
- Existing per-destination events are preserved and now include the same
  attribution. GLB and Community also have explicit per-destination events.

Count unique people, not event totals. Do not add generic item events to the
per-destination events: both describe the same click. Anyone choosing multiple
destinations counts in each destination; deduplicate when reporting any-tool use.

## Follow-up session prompt

A one-time local Codex CLI report is registered with macOS launchd for
**October 24, 2026, at 9:00 AM America/Chicago**, emailing the report to
**jake@brickbuilder.ai**. The saved runtime prompt and baseline live in
`~/.codex/scheduled-reports/brickbuilder-20261024/` so cleanup of this worktree
will not remove them. The Mac must be on with the user logged in; missed runs
are checked again at login or on the next 15-minute due check. A durable
attempt marker prevents duplicate reports. Each job removes its own launch
agent after its one attempt. Logs and the final report remain in that folder.

At the scheduled time, report available data even if deployment is delayed;
do not label a partial week as a complete one. Send a status email if the
change has not reached production. A successful CLI exit is not itself proof
of email delivery: check the session report for Gmail's send confirmation.

Launch-agent label: `ai.brickbuilder.codex-report-tools-20261024`.
The companion upload-placement report runs at 9:20 AM; the runner serializes
browser access between the two sessions.

> Check BrickBuilder's PostHog project 332024 using the existing signed-in
> BrickBuilder account (brickai1738@gmail.com). Read this comparison document
> and inspect production rollout timing before choosing the reporting window.
> Compare seven full days of Tools dropdown use against the recorded baseline.
> Filter every metric to the production hosts and homepage pathname `/`.
> Report unique homepage visitors from `$pageview`, unique dropdown viewers,
> unique Tools openers, and unique `landing_header_tools_item_clicked` people
> by destination. Calculate each destination's clickers / homepage visitors,
> and also show openers / dropdown viewers and clickers / Tools openers.
> Compare homepage click rates to the baseline using percentage-point changes.
> Report OBJ separately without inventing an old baseline. Show sample sizes,
> the exact UTC reporting window, exposure coverage, and whether seven full
> post-rollout days are available. If rollout is incomplete or delayed, report
> available days without mixing in pre-dropdown events or claiming a full-week
> result. Keep recommendations cautious: this is a before/after comparison,
> and the lower sections' scroll reveal changed at the same time. Recommend
> whether to keep Tools or restore individual header links. Read and report
> only; do not change code, deploy, or merge a pull request. Send the report
> to jake@brickbuilder.ai using Gmail and confirm delivery.
