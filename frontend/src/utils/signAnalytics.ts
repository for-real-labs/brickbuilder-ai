import type { PostHog } from 'posthog-js';

/** Attribute the printed car decal's homepage link for the current session. */
export function captureSignVisit(posthog: PostHog, search = window.location.search): void {
  if (new URLSearchParams(search).get('sign') !== 'car-decal') return;

  const properties = {
    sign_id: 'car-decal',
    utm_source: 'car-decal',
    utm_medium: 'qr',
    utm_campaign: 'printed-sign',
  };
  posthog.register_for_session(properties);
  posthog.capture('sign_qr_visit', properties);
}
