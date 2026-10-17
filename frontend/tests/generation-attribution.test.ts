import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '../src/services/apiFetch';
import { withGenerationEntryPage } from '../src/utils/generationAttribution';

afterEach(() => { window.history.replaceState({}, '', '/'); vi.restoreAllMocks(); });
it.each(['/image-to-lego', '/photo-to-lego', '/', '/generated-model'])('attributes JSON requests from %s without URL query data', async page => {
  window.history.replaceState({}, '', `${page}?token=private`);
  const fetch = vi.spyOn(window, 'fetch').mockResolvedValue(new Response('{}'));
  await apiFetch('http://localhost:8002/novaToBricks', { method: 'POST', body: JSON.stringify({ prompt: 'castle' }) });
  expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toEqual({ prompt: 'castle', entry_page: page });
});
it.each(['/glbToBricks', '/objToBricks', '/uploadLdraw'])('attributes multipart %s without changing original form', endpoint => {
  window.history.replaceState({}, '', '/use-ai-to-edit-ldraw');
  const file = new File(['data'], 'castle.io');
  const form = new FormData(); form.append('file', file);
  const result = withGenerationEntryPage(endpoint, { method: 'POST', body: form });
  expect((result.body as FormData).get('entry_page')).toBe('/use-ai-to-edit-ldraw');
  expect((result.body as FormData).get('file')).toBe(file);
  expect(form.has('entry_page')).toBe(false);
});
it('leaves polling and unrelated requests unchanged', () => {
  const init = { method: 'POST', body: '{"prompt":"castle"}' };
  expect(withGenerationEntryPage('/createCheckoutSession', init)).toBe(init);
  expect(withGenerationEntryPage('/generation/abc', {})).toEqual({});
});
