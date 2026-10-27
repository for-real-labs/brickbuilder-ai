import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { captureInstructionLink, getInstructionKey, instructionKeys, instructionsUrl } from '../src/utils/instructionLinks';
import { NovaToBricksApiService } from '../src/services/novaToBricksApi';

vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }));
const id = '00000000-0000-4000-8000-000000000001';
const key = 'a'.repeat(43);

beforeEach(() => { sessionStorage.clear(); window.history.replaceState(null, '', '/'); });
afterEach(() => { sessionStorage.clear(); window.history.replaceState(null, '', '/'); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('strips the key from the URL before analytics and keeps it scoped to this model in the tab', () => {
  window.history.replaceState({ selected: true }, '', `/instructions?id=${id}#access=${key}`);
  captureInstructionLink();
  expect(window.location.hash).toBe('');
  expect(window.history.state).toEqual({ selected: true });
  expect(getInstructionKey(id)).toBe(key);
  expect(getInstructionKey('other')).toBeUndefined();
  expect(instructionKeys()).toEqual([[id, key]]);
  expect(instructionsUrl(id)).toBe(`https://brickbuilder.ai/?id=${id}&exact=1&instructions=1#access=${key}`);
  expect(JSON.stringify(localStorage)).not.toContain(key);
});

it.each([['public-uuid', id], [key, 'not-a-model-id']])('removes malformed keys without retaining or granting them', (token, generationId) => {
  window.history.replaceState(null, '', `/instructions?id=${generationId}#access=${token}&section=parts`);
  captureInstructionLink();
  expect(window.location.hash).toBe('#section=parts');
  expect(instructionKeys()).toEqual([]);
});

it('sends the key only to the matching instruction endpoints in a header', async () => {
  sessionStorage.setItem(`brickbuilder:instruction-key:${id}`, key);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{"allowed":true}', { headers: { 'Content-Type': 'application/json' } }))
    .mockResolvedValueOnce(new Response('0 STEP')).mockResolvedValueOnce(new Response('0 STEP'))
    .mockResolvedValueOnce(new Response('archive')));
  expect(await NovaToBricksApiService.instructionAccess(id, key)).toBe(true);
  await NovaToBricksApiService.instructions(id);
  await NovaToBricksApiService.instructions('another-model');
  await NovaToBricksApiService.downloadSource(id);
  const calls = vi.mocked(fetch).mock.calls;
  expect(calls.every(([url]) => !String(url).includes(key))).toBe(true);
  expect(calls.map(([, init]) => new Headers(init?.headers).get('X-Instruction-Key'))).toEqual([key, key, null, null]);
  expect(calls[0][1]?.cache).toBe('no-store');
});

it('never treats invalid or unavailable validation responses as access', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{"allowed":false}'))
    .mockResolvedValueOnce(new Response('{"allowed":"true"}')).mockResolvedValueOnce(new Response('', { status: 503 })));
  expect(await NovaToBricksApiService.instructionAccess(id, key)).toBe(false);
  expect(await NovaToBricksApiService.instructionAccess(id, key)).toBe(false);
  await expect(NovaToBricksApiService.instructionAccess(id, key)).rejects.toThrow('Could not verify');
});
