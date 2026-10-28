import { afterEach, expect, it, vi } from 'vitest';
const create = vi.hoisted(() => vi.fn((_url: string, _key: string, _options: any) => ({ auth: {} })));
vi.mock('@supabase/supabase-js', () => ({ createClient: create }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); create.mockClear(); history.replaceState(null, '', '/'); });
it('keeps regular sign-in on PKCE and sends cross-browser recovery mail without a verifier or second persisted session', async () => {
 vi.stubEnv('VITE_SUPABASE_URL','https://example.supabase.co'); vi.stubEnv('VITE_SUPABASE_ANON_KEY','public-key');
 const { passwordRecoveryClient } = await import('../src/lib/supabase');
 expect(create.mock.calls[0][2].auth.flowType).toBe('pkce');
 passwordRecoveryClient(); passwordRecoveryClient();
 expect(create).toHaveBeenCalledTimes(2);
 expect(create.mock.calls[1][2].auth).toMatchObject({ flowType:'implicit', persistSession:false, detectSessionInUrl:false, autoRefreshToken:false });
});
it('accepts the recovery session on the dedicated landing page', async () => {
 history.replaceState(null,'','/reset-password'); vi.stubEnv('VITE_SUPABASE_URL','https://example.supabase.co'); vi.stubEnv('VITE_SUPABASE_ANON_KEY','public-key');
 await import('../src/lib/supabase'); expect(create.mock.calls[0][2].auth.flowType).toBe('implicit');
});
it('returns safe configuration errors in local anonymous mode', async () => {
 vi.stubEnv('VITE_SUPABASE_URL',''); vi.stubEnv('VITE_SUPABASE_ANON_KEY','');
 const { supabase, passwordRecoveryClient }=await import('../src/lib/supabase');
 expect(passwordRecoveryClient()).toBe(supabase);
 expect((await supabase.auth.resetPasswordForEmail('test@example.test')).error).toBeTruthy();
 expect((await supabase.auth.updateUser({password:'new-password'})).error).toBeTruthy();
 expect((await supabase.rpc('account_has_password')).error).toBeTruthy();
});
