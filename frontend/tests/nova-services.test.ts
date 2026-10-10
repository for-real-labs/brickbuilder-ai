import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NOVA_OPTIONS, NovaToBricksApiService } from '../src/services/novaToBricksApi';
import { LocalProvidersApiService, safeProviderLoginUrl } from '../src/services/localProvidersApi';
import { isAgentGeneration } from '../src/utils/agentGeneration';

const response = (data: unknown, status = 200) => ({
  ok: status < 400, status, json: vi.fn().mockResolvedValue(data),
}) as unknown as Response;
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'owner-token' } } }) } } }));

beforeEach(() => vi.stubGlobal('fetch', vi.fn()));

describe('Nova agent API', () => {
  it('starts a native agent build with owner credentials', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ generation_id: 'set', message: 'Started' }));
    await expect(NovaToBricksApiService.generate({ ...DEFAULT_NOVA_OPTIONS, prompt: '  orbital launch site  ', authMode: 'native', imageBase64: 'pixels' }, 'token')).resolves.toMatchObject({ generation_id: 'set' });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/novaToBricks');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token');
    expect(new Headers(init?.headers).has('X-Guest-Session')).toBe(true);
    expect(JSON.parse(init?.body as string)).toEqual({
      prompt: 'orbital launch site', image_base64: 'pixels', image_media_type: 'image/png', detail_level: 40,
      model: DEFAULT_NOVA_OPTIONS.model, auth_mode: 'native',
    });
  });

  it.each([
    { prompt: '', error: 'prompt or image' },
    { model: 'untrusted-model', error: 'supported agent model' },
    { authMode: 'unknown', error: 'supported provider connection' },
  ])('validates input before starting a job: $error', async ({ error, ...options }) => {
    await expect(NovaToBricksApiService.generate({ ...DEFAULT_NOVA_OPTIONS, prompt: 'castle', ...options } as never)).rejects.toThrow(error);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends follow-up edits to Nova with the source generation identity', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ generation_id: 'revision', message: 'Started' }));
    await NovaToBricksApiService.edit('original', 'Make the roof red', 'owner-token');
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)).toMatchObject({
      source_generation_id: 'original', prompt: 'Make the roof red',
    });
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain('/novaToBricks');
  });

  it('allows image-only references and reports startup errors', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ detail: 'Connect Claude before starting an agent' }, 400));
    await expect(NovaToBricksApiService.generate({ ...DEFAULT_NOVA_OPTIONS, imageBase64: 'pixels' })).rejects.toThrow('Connect Claude');
    vi.mocked(fetch).mockResolvedValueOnce(response({ message: 'Started' }));
    await expect(NovaToBricksApiService.generate({ ...DEFAULT_NOVA_OPTIONS, prompt: 'castle' })).rejects.toThrow('generation ID');
  });

  it('recognizes both agent endpoints for reusable output viewers', () => {
    expect(isAgentGeneration('novaToBricks')).toBe(true);
    expect(isAgentGeneration('llmToBricks')).toBe(true);
    expect(isAgentGeneration('imageToBricks')).toBe(false);
    expect(isAgentGeneration()).toBe(false);
  });

  it('downloads source with owner authorization and reports forbidden or missing archives', async () => {
    const archive = new Blob(['archive'], { type: 'application/zip' });
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, blob: async () => archive } as Response);
    expect(await NovaToBricksApiService.downloadSource('set/id')).toBe(archive);
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain('/generation/set%2Fid/nova-source');
    expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer owner-token');
    vi.mocked(fetch).mockResolvedValueOnce(response({}, 403));
    await expect(NovaToBricksApiService.downloadSource('set')).rejects.toThrow('Only the owner');
    vi.mocked(fetch).mockResolvedValueOnce(response({}, 404));
    await expect(NovaToBricksApiService.downloadSource('set')).rejects.toThrow('unavailable');
  });
});

describe('local provider API', () => {
  it('attaches keys only to the local server and never persists them in browser storage', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ id: 'fal', api_key_configured: true }));
    await LocalProvidersApiService.saveApiKey('fal', '  private-key  ');
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8002/local/providers/fal/credentials');
    expect(init?.method).toBe('POST');
    expect(init?.cache).toBe('no-store');
    expect(JSON.parse(init?.body as string)).toEqual({ api_key: 'private-key' });
    expect(JSON.stringify(localStorage)).not.toContain('private-key');
    expect(JSON.stringify(sessionStorage)).not.toContain('private-key');
  });

  it('starts and cancels login, removes keys, and supports abortable status polling', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ id: 'openai' }));
    await LocalProvidersApiService.login('openai');
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{}' });
    await LocalProvidersApiService.cancelLogin('openai');
    expect(vi.mocked(fetch).mock.calls[1][0]).toContain('/openai/login');
    expect(vi.mocked(fetch).mock.calls[1][1]?.method).toBe('DELETE');
    await LocalProvidersApiService.removeApiKey('anthropic');
    expect(vi.mocked(fetch).mock.calls[2][0]).toContain('/anthropic/credentials');
    expect(vi.mocked(fetch).mock.calls[2][1]?.method).toBe('DELETE');
    const controller = new AbortController();
    await LocalProvidersApiService.getStatus(controller.signal);
    expect(vi.mocked(fetch).mock.calls[3][1]?.signal).toBe(controller.signal);
  });

  it('does not reflect rejected credentials into errors', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ detail: 'private-key was rejected' }, 400));
    await expect(LocalProvidersApiService.saveApiKey('fal', 'private-key')).rejects.toThrow('Unable to update');
    vi.mocked(fetch).mockResolvedValue(response({}, 404));
    await expect(LocalProvidersApiService.getStatus()).rejects.toThrow('disabled');
    await expect(LocalProvidersApiService.saveApiKey('fal', ' ')).rejects.toThrow('Enter an API key');
  });

  it('sends a manual Claude authorization code only to the local authentication endpoint', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ id: 'anthropic' }));
    await LocalProvidersApiService.submitClaudeCode('  private-code  ');
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain('/local/providers/anthropic/login/code');
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)).toEqual({ code: 'private-code' });
    await expect(LocalProvidersApiService.submitClaudeCode(' ')).rejects.toThrow('Enter the Claude');
  });

  it.each(['https://attacker.example/signin', 'http://auth.openai.com/login', 'https://auth.openai.com.attacker.example', 'javascript:alert(1)', 'https://user:pass@auth.openai.com'])('rejects unsafe browser login URL %s', value => {
    expect(safeProviderLoginUrl('openai', value)).toBeUndefined();
  });

  it('allows only the selected provider authentication domains', () => {
    expect(safeProviderLoginUrl('openai', 'https://auth.openai.com/device')).toBe('https://auth.openai.com/device');
    expect(safeProviderLoginUrl('anthropic', 'https://claude.ai/oauth/authorize')).toContain('claude.ai');
    expect(safeProviderLoginUrl('anthropic', 'https://claude.com/oauth/authorize')).toBe('https://claude.com/oauth/authorize');
    expect(safeProviderLoginUrl('anthropic', 'https://platform.claude.com/oauth/authorize')).toBe('https://platform.claude.com/oauth/authorize');
    expect(safeProviderLoginUrl('anthropic', 'https://console.anthropic.com/oauth/authorize')).toBe('https://console.anthropic.com/oauth/authorize');
    expect(safeProviderLoginUrl('anthropic', 'https://claude.com.attacker.example/oauth')).toBeUndefined();
    expect(safeProviderLoginUrl('fal', 'https://fal.ai/auth')).toContain('fal.ai');
    expect(safeProviderLoginUrl('fal', 'https://claude.ai')).toBeUndefined();
  });
});
