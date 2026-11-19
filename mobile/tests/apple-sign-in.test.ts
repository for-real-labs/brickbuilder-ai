import { beforeEach, expect, it, vi } from 'vitest';
import * as AppleAuthentication from 'expo-apple-authentication';
import { APPLE_SIGN_IN_EVENT, AppleSignIn, appleSignInDispatch } from '../src/appleSignIn';

vi.mock('expo-apple-authentication', () => ({
  AppleAuthenticationScope: { EMAIL: 1 },
  isAvailableAsync: vi.fn(async () => true),
  signInAsync: vi.fn(),
}));

const origin = 'https://brickbuilder.ai';
const id = '00000000-0000-4000-8000-000000000001';
const nonce = '0'.repeat(64);
const message = JSON.stringify({ type: APPLE_SIGN_IN_EVENT, id, nonce });

beforeEach(() => vi.clearAllMocks());

it('only opens an Apple request for the app origin and a valid challenge', async () => {
  const handler = new AppleSignIn(origin, vi.fn());
  await handler.handle(message, 'https://billing.stripe.com');
  await handler.handle(JSON.stringify({ type: APPLE_SIGN_IN_EVENT, id, nonce: 'bad' }), origin);
  expect(AppleAuthentication.signInAsync).not.toHaveBeenCalled();
});

it('relays the matching credential and authorization code to the original origin', async () => {
  const emit = vi.fn();
  const handler = new AppleSignIn(origin, emit);
  vi.mocked(AppleAuthentication.signInAsync).mockResolvedValueOnce({
    state: id, identityToken: 'token', authorizationCode: 'code',
  } as AppleAuthentication.AppleAuthenticationCredential);
  await handler.handle(message, origin + '/login');
  expect(AppleAuthentication.signInAsync).toHaveBeenCalledWith({ state: id, nonce, requestedScopes: [1] });
  expect(emit).toHaveBeenCalledWith({ id, token: 'token', code: 'code' });
  expect(appleSignInDispatch({ id, token: 'token', code: 'code' }, origin)).toContain('window.location.origin === "https://brickbuilder.ai"');
});

it('returns no credential for cancellation or mismatched state', async () => {
  const emit = vi.fn();
  const handler = new AppleSignIn(origin, emit);
  vi.mocked(AppleAuthentication.signInAsync).mockRejectedValueOnce({ code: 'ERR_REQUEST_CANCELED' });
  await handler.handle(message, origin);
  expect(emit).toHaveBeenLastCalledWith({ id, cancelled: true });
  vi.mocked(AppleAuthentication.signInAsync).mockResolvedValueOnce({
    state: 'wrong', identityToken: 'token', authorizationCode: 'code',
  } as AppleAuthentication.AppleAuthenticationCredential);
  await handler.handle(message, origin);
  expect(emit).toHaveBeenLastCalledWith({ id, error: true });
});
