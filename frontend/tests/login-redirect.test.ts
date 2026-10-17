import { describe, expect, it } from 'vitest';
import { isOAuthLogin, loginRedirect } from '../src/utils/loginRedirect';

const consent = '/oauth/consent?authorization_id=review-request';

describe('login destinations', () => {
  it('recovers the complete OAuth request from the URL after a reload', () => {
    expect(loginRedirect(`?${new URLSearchParams({ next: consent })}`)).toBe(consent);
    expect(isOAuthLogin(consent)).toBe(true);
  });

  it('supports existing router state and prefers the durable URL destination', () => {
    expect(loginRedirect('', consent)).toBe(consent);
    expect(loginRedirect('?next=%2Fcommunity', consent)).toBe('/community');
    expect(loginRedirect('')).toBe('/dashboard');
  });

  it.each(['https://evil.example', '//evil.example', '/\\evil.example', '/\nevil.example', ' /dashboard'])(
    'rejects unsafe destinations: %s', destination => {
      expect(loginRedirect(`?${new URLSearchParams({ next: destination })}`)).toBe('/dashboard');
      expect(loginRedirect('', destination)).toBe('/dashboard');
    },
  );

  it.each(['/oauth/consent', '/oauth/consent?authorization_id=', '/dashboard?authorization_id=x'])(
    'does not choose OAuth sign-in without a consent request: %s', destination => {
      expect(isOAuthLogin(destination)).toBe(false);
    },
  );
});
