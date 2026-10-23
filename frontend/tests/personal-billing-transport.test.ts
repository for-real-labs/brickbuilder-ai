import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '../src/services/apiFetch';
const auth = vi.hoisted(() => ({ token: 'alice-token' }));
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { access_token: auth.token } } }) } } }));
vi.mock('../src/utils/aiConsent', () => ({ requiresAiConsent: () => false, ensureAiConsent: async () => {} }));
const response = (data: unknown) => new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
beforeEach(() => { auth.token = 'alice-token'; vi.stubGlobal('fetch', vi.fn()); });
afterEach(() => vi.unstubAllGlobals());
const generate = () => apiFetch('http://127.0.0.1:8002/novaToBricks',{method:'POST',headers:{Authorization:'Bearer alice-token'},body:JSON.stringify({model:'gpt-5.5',prompt:'castle',auth_mode:'api_key'})});
it('sends an explicit billing choice only after account settings resolve, without sending keys in the generation body', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(response({billing_source:'personal',skip_confirmation:true,providers:['openai']})).mockResolvedValueOnce(response({generation_id:'build'}));
  await generate();
  expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('/provider-keys');
  const [url,init] = vi.mocked(fetch).mock.calls[1];
  expect(url).toContain('/novaToBricks');
  expect(JSON.parse(init?.body as string)).toMatchObject({billing_source:'personal'});
  expect(init?.body).not.toContain('api_key":');
});
it('does not start a personal build after the signed-in account changes', async () => {
  vi.mocked(fetch).mockImplementationOnce(async () => { auth.token='bob-token'; return response({billing_source:'personal',skip_confirmation:true,providers:['openai']}); });
  await expect(generate()).rejects.toThrow('Your sign-in changed');
  expect(fetch).toHaveBeenCalledTimes(1);
});
