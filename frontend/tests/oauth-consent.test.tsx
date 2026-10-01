import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';

const auth = vi.hoisted(() => ({ user: { email: 'builder@example.com' } as { email: string } | null, loading: false }));
const oauth = vi.hoisted(() => ({ getAuthorizationDetails: vi.fn(), approveAuthorization: vi.fn(), denyAuthorization: vi.fn() }));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../src/lib/supabase', () => ({ isSupabaseConfigured: true, supabase: { auth: { oauth } } }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
import OAuthConsentPage from '../src/pages/OAuthConsentPage';

const details = {
  authorization_id: 'auth-id',
  client: { id: 'client-id', name: 'Claude' },
  scope: 'email', redirect_uri: 'https://claude.ai/oauth/callback',
};
let root: Root;
let container: HTMLDivElement;

function LoginDestination() {
  const location = useLocation();
  return <div>Login: {location.state?.from}</div>;
}

async function render(path = '/oauth/consent?authorization_id=auth-id') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(
    <MemoryRouter initialEntries={[path]}><Routes>
      <Route path="/oauth/consent" element={<OAuthConsentPage />} />
      <Route path="/login" element={<LoginDestination />} />
    </Routes></MemoryRouter>,
  ));
}

async function click(label: string) {
  const button = Array.from(container.querySelectorAll('button')).find(button => button.textContent === label);
  expect(button).toBeTruthy();
  await act(async () => button?.click());
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.user = { email: 'builder@example.com' };
  auth.loading = false;
  oauth.getAuthorizationDetails.mockResolvedValue({ data: details, error: null });
  oauth.approveAuthorization.mockResolvedValue({ data: { redirect_url: 'https://claude.ai/oauth/callback?code=x' }, error: null });
  oauth.denyAuthorization.mockResolvedValue({ data: { redirect_url: 'https://claude.ai/oauth/callback?error=access_denied' }, error: null });
  vi.stubGlobal('location', { ...window.location, assign: vi.fn() });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

describe('OAuth consent', () => {
  it('shows the requesting client, permissions, and credit cost without granting access', async () => {
    await render();
    expect(container.textContent).toContain('Claude');
    expect(container.textContent).toContain('builder@example.com');
    expect(container.textContent).toContain('one account credit');
    expect(container.textContent).toContain('parts lists');
    expect(oauth.approveAuthorization).not.toHaveBeenCalled();
  });

  it('preserves authorization through login', async () => {
    auth.user = null;
    await render();
    expect(container.textContent).toBe('Login: /oauth/consent?authorization_id=auth-id');
    expect(oauth.getAuthorizationDetails).not.toHaveBeenCalled();
  });

  it('waits for authentication and handles missing or expired requests', async () => {
    auth.loading = true;
    auth.user = null;
    await render();
    expect(container.textContent).toContain('Loading connection request');
    expect(oauth.getAuthorizationDetails).not.toHaveBeenCalled();
  });

  it('offers guidance when no authorization ID is present', async () => {
    await render('/oauth/consent');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Start a connection');
    expect(oauth.getAuthorizationDetails).not.toHaveBeenCalled();
  });

  it('reports expired requests without approval controls', async () => {
    oauth.getAuthorizationDetails.mockResolvedValue({ data: null, error: { message: 'expired' } });
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('expired');
    expect(container.querySelector('button')).toBeNull();
  });

  it('approves explicitly and redirects only to the provider callback', async () => {
    await render('/oauth/consent?authorization_id=auth-id&redirect=https://evil.example.com');
    await click('Allow connection');
    expect(oauth.approveAuthorization).toHaveBeenCalledWith('auth-id', { skipBrowserRedirect: true });
    expect(window.location.assign).toHaveBeenCalledWith('https://claude.ai/oauth/callback?code=x');
    expect(posthog.capture).toHaveBeenCalledWith('mcp_connection_decision', { approved: true, client_id: 'client-id' });
  });

  it('allows denial and records the decision without approving', async () => {
    await render();
    await click('Cancel');
    expect(oauth.denyAuthorization).toHaveBeenCalledWith('auth-id', { skipBrowserRedirect: true });
    expect(oauth.approveAuthorization).not.toHaveBeenCalled();
    expect(window.location.assign).toHaveBeenCalledWith('https://claude.ai/oauth/callback?error=access_denied');
  });

  it('rejects callback substitution and insecure URLs', async () => {
    oauth.approveAuthorization.mockResolvedValue({ data: { redirect_url: 'https://evil.example.com/callback?code=x' }, error: null });
    await render();
    await click('Allow connection');
    expect(window.location.assign).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Unable to finish');
  });

  it('handles provider errors and re-enables controls', async () => {
    oauth.approveAuthorization.mockRejectedValue(new Error('provider unavailable'));
    await render();
    await click('Allow connection');
    expect(container.querySelector('[role="alert"]')).toBeTruthy();
    expect(Array.from(container.querySelectorAll('button')).every(button => !button.disabled)).toBe(true);
  });

  it('finishes reconnection after a previously granted consent', async () => {
    oauth.getAuthorizationDetails.mockResolvedValue({ data: { redirect_url: 'https://claude.ai/oauth/callback?code=existing' }, error: null });
    await render();
    expect(window.location.assign).toHaveBeenCalledWith('https://claude.ai/oauth/callback?code=existing');
    expect(oauth.approveAuthorization).not.toHaveBeenCalled();
  });
});
