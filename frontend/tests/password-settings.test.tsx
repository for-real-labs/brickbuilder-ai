import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ status: vi.fn(), reset: vi.fn(), save: vi.fn(), session: vi.fn() }));
vi.mock('../src/services/passwordAuth', () => ({ hasAccountPassword: mocks.status, sendPasswordRecovery: mocks.reset, saveAccountPassword: mocks.save }));
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { getSession: mocks.session } } }));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'current-user', email: 'person@example.test' } }) }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
import { PasswordSettings } from '../src/components/PasswordSettings';
import { PasswordRecovery } from '../src/components/PasswordRecovery';
import { PasswordEditor } from '../src/components/PasswordEditor';
import ResetPasswordPage from '../src/pages/ResetPasswordPage';
let container: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.resetAllMocks(); container=document.createElement('div'); document.body.append(container); root=createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
const render = async (node: React.ReactNode) => act(async () => root.render(node));
const click = async (label: string) => act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent===label)!.click(); });
const setInput = async (index: number, value: string) => act(async () => {
 const input=container.querySelectorAll('input')[index]; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value); input.dispatchEvent(new Event('input',{bubbles:true}));
});
const submit = async () => act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); });
it('shows Set password for an OTP account then Reset password after saving', async () => {
 mocks.status.mockResolvedValue(false); mocks.save.mockResolvedValue(undefined);
 await render(<PasswordSettings />); await click('Set password');
 await setInput(0,'long-password'); await setInput(1,'long-password'); await submit();
 expect(mocks.save).toHaveBeenCalledWith('long-password'); expect(container.textContent).toContain('Password saved'); expect(container.textContent).toContain('Reset password');
});
it('sends an existing-password account a Supabase recovery email', async () => {
 mocks.status.mockResolvedValue(true); mocks.reset.mockResolvedValue(undefined);
 await render(<PasswordSettings />); await click('Reset password');
 expect(mocks.reset).toHaveBeenCalledWith('person@example.test'); expect(container.textContent).toContain('Check your email');
});
it('does not guess Set password when status failed and allows retry', async () => {
 mocks.status.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(false);
 await render(<PasswordSettings />); expect(container.textContent).not.toContain('Set password');
 await click('Try again'); expect(container.textContent).toContain('Set password');
});
it('rejects mismatched passwords and reports Supabase errors without claiming success', async () => {
 const saved=vi.fn(); await render(<PasswordEditor onSaved={saved} surface="test" />);
 await setInput(0,'long-password'); await setInput(1,'wrong-password'); await submit();
 expect(mocks.save).not.toHaveBeenCalled(); expect(container.textContent).toContain('Passwords do not match');
 await setInput(1,'long-password'); mocks.save.mockRejectedValue(new Error('Session expired')); await submit();
 expect(saved).not.toHaveBeenCalled(); expect(container.textContent).toContain('Session expired');
});
it('requires email for recovery and uses a non-enumerating success message', async () => {
 await render(<PasswordRecovery email="" surface="test" />); await click('Can’t log in? Email me a password reset link');
 expect(mocks.reset).not.toHaveBeenCalled();
 await render(<PasswordRecovery email="person@example.test" surface="test" />); mocks.reset.mockResolvedValue(undefined);
 await click('Can’t log in? Email me a password reset link'); expect(container.textContent).toContain('If an account exists');
});
it('expired or missing recovery sessions show a new-link option, not a password form', async () => {
 mocks.session.mockResolvedValue({data:{session:null},error:null});
 await render(<MemoryRouter><ResetPasswordPage /></MemoryRouter>);
 expect(container.querySelector('input[type="password"]')).toBeNull(); expect(container.textContent).toContain('expired');
});
it('valid recovery sessions can save a password and reach confirmation', async () => {
 mocks.session.mockResolvedValue({data:{session:{user:{id:'test'}}},error:null}); mocks.save.mockResolvedValue(undefined);
 await render(<MemoryRouter><ResetPasswordPage /></MemoryRouter>);
 await setInput(0,'new-password'); await setInput(1,'new-password'); await submit();
 expect(container.textContent).toContain('Password saved'); expect(container.querySelector('input[type="password"]')).toBeNull();
});

it('does not show the password editor for an expired callback even with an older session', async () => {
 history.replaceState(null,'','/reset-password?error_code=otp_expired');
 vi.resetModules();
 const { default: ExpiredPage } = await import('../src/pages/ResetPasswordPage');
 mocks.session.mockResolvedValue({data:{session:{user:{id:'old'}}},error:null});
 try {
  await render(<MemoryRouter><ExpiredPage /></MemoryRouter>);
  expect(container.querySelector('input[type="password"]')).toBeNull();
  expect(container.textContent).toContain('expired');
 } finally { history.replaceState(null,'','/'); }
});
