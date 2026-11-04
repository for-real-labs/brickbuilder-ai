import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LandingCommunityAction } from '../src/components/LandingCommunityAction';

const mock = vi.hoisted(() => ({
  user: null as { id: string } | null, read: vi.fn(), rename: vi.fn(), toggle: vi.fn(), claim: vi.fn(),
}));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => ({
  user: mock.user, loading: false, session: mock.user ? { access_token: 'token' } : null,
}) }));
vi.mock('../src/lib/supabase', () => ({ supabase: { from: () => ({
  select: () => ({ eq: () => ({ maybeSingle: mock.read }) }),
}) } }));
vi.mock('../src/components/LoginModal', () => ({ default: ({ open }: { open: boolean }) => open ? <div>Sign in to post</div> : null }));
vi.mock('../src/services/claimGenerationApi', () => ({ ClaimGenerationApiService: { claimGeneration: mock.claim } }));
vi.mock('../src/services/updateGenerationNameApi', () => ({ UpdateGenerationNameApiService: { updateGenerationName: mock.rename } }));
vi.mock('../src/services/toggleIsCommunityApi', () => ({ ToggleIsCommunityApiService: { toggleIsCommunity: mock.toggle } }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const render = () => act(async () => root.render(<LandingCommunityAction id="castle" busy={false} preview={() => undefined} />));
const button = (name: string) => [...container.querySelectorAll('button')].find(node => node.textContent === name)!;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  mock.user = null;
  mock.read.mockResolvedValue({ data: { user_id: 'owner', is_community: false, preview_image_url: 'existing' } });
  mock.claim.mockResolvedValue({ claimed: true });
  mock.toggle.mockResolvedValue({ is_community: true });
  sessionStorage.clear();
  localStorage.clear();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('asks guests to sign in and never offers a non-owner a publishing action', async () => {
  await render();
  act(() => button('Post to Community').click());
  expect(document.body.textContent).toContain('Sign in to post');
  mock.user = { id: 'someone-else' };
  await render();
  expect(container.querySelector('dialog')).toBeNull();
  expect(container.textContent).toContain('Only the owner');
  expect(mock.claim).not.toHaveBeenCalled();
  expect(mock.toggle).not.toHaveBeenCalled();
});

it('resumes the naming step after login and publishes only after owner confirmation', async () => {
  localStorage.setItem('anon_generation_ids_v2', JSON.stringify(['castle']));
  await render();
  act(() => button('Post to Community').click());
  mock.user = { id: 'owner' };
  await render();
  expect(mock.claim).toHaveBeenCalledWith('castle', 'token');
  expect(container.querySelector('dialog')?.open).toBe(true);
  expect(mock.toggle).not.toHaveBeenCalled();
  const input = container.querySelector('input')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Castle');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(mock.rename).toHaveBeenCalledWith('castle', 'Castle', 'token');
  expect(mock.toggle).toHaveBeenCalledWith('castle', 'token');
  expect(button('Remove from Community')).toBeDefined();
  mock.toggle.mockResolvedValue({ is_community: false });
  await act(async () => button('Remove from Community').click());
  expect(container.querySelector('dialog')).toBeNull();
  expect(mock.rename).toHaveBeenCalledTimes(1);
  expect(button('Post to Community')).toBeDefined();
});
