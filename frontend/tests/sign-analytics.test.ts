import { describe, expect, it, vi } from 'vitest';
import type { PostHog } from 'posthog-js';
import { captureSignVisit } from '../src/utils/signAnalytics';

function analytics() {
  return { register_for_session: vi.fn(), capture: vi.fn() };
}

describe('printed sign attribution', () => {
  it('captures the decal visit and attributes subsequent session events', () => {
    const client = analytics();
    captureSignVisit(client as unknown as PostHog, '?sign=car-decal');
    const properties = {
      sign_id: 'car-decal', utm_source: 'car-decal',
      utm_medium: 'qr', utm_campaign: 'printed-sign',
    };
    expect(client.register_for_session).toHaveBeenCalledWith(properties);
    expect(client.capture).toHaveBeenCalledWith('sign_qr_visit', properties);
    expect(client.register_for_session.mock.invocationCallOrder[0])
      .toBeLessThan(client.capture.mock.invocationCallOrder[0]);
  });

  it.each(['', '?sign=unknown', '?sign=', '?other=car-decal', '?sign=%3Cscript%3E'])
    ('ignores unrecognized or absent sign parameters: %s', search => {
      const client = analytics();
      captureSignVisit(client as unknown as PostHog, search);
      expect(client.register_for_session).not.toHaveBeenCalled();
      expect(client.capture).not.toHaveBeenCalled();
    });
});
