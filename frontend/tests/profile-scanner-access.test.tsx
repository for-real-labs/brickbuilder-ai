import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { PhotoScannerApi } from '../src/services/photoScannerApi';
import { ProfileMenu } from '../src/components/ProfileMenu';
const auth = vi.hoisted(() => ({ user: null as null | { id: string; email: string }, userProfile: { username: 'Jake' }, isSupabaseConfigured: true, signOut: vi.fn() }));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../src/contexts/GenerationNotificationsContext', () => ({ useGenerationNotifications: () => ({ unread_count: 0 }) }));
vi.mock('../src/components/BillingComponents', () => ({ CreditBalance: () => null }));
vi.mock('../src/components/ChangeRequestLauncher', () => ({ ChangeRequestMenuItem: () => null }));
vi.mock('../src/components/NotificationMenu', () => ({ NotificationPanel: () => null }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => { auth.user = null; auth.isSupabaseConfigured = true; host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });
function mount(navigate = vi.fn()) { act(() => root.render(<MemoryRouter><ProfileMenu showCredits={false} onNavigate={navigate} /></MemoryRouter>)); act(() => host.querySelector('button')!.click()); return navigate; }
it('labels local navigation as unsigned local workspace', () => {
 auth.isSupabaseConfigured = false; mount(); expect(host.querySelector('[aria-label="Local workspace"]')).not.toBeNull(); expect(host.textContent).toContain('not signed in'); expect(host.querySelector('a')?.href).toBe('https://brickbuilder.ai/login'); expect(host.textContent).not.toContain('Photo Scanner');
});
it('shows the signed-in email and a scanner shortcut after approval', async () => {
 const email = 'approved@example.com';
 auth.user = { id: 'approved', email };
 vi.spyOn(PhotoScannerApi, 'access').mockResolvedValue({ allowed: true });
 const navigate = vi.fn();
 await act(async () => root.render(<MemoryRouter><ProfileMenu showCredits={false} onNavigate={navigate} /></MemoryRouter>));
 act(() => host.querySelector('button')!.click());
 expect(host.textContent).toContain(email);
 act(() => [...host.querySelectorAll('button')].find(button => button.textContent === 'Photo Scanner')!.click()); expect(navigate).toHaveBeenCalledWith('/photo-scanner');
});
it('hides the private shortcut from other accounts', async () => {
 auth.user = { id: 'other', email: 'other@example.com' };
 vi.spyOn(PhotoScannerApi, 'access').mockResolvedValue({ allowed: false });
 await act(async () => root.render(<MemoryRouter><ProfileMenu showCredits={false} /></MemoryRouter>));
 act(() => host.querySelector('button')!.click());
 expect(host.textContent).not.toContain('Photo Scanner');
});
