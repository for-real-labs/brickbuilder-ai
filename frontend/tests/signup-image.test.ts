import { beforeEach, expect, it, vi } from 'vitest';
import { restoreSignupImage, saveSignupImage } from '../src/utils/signupImage';
beforeEach(() => sessionStorage.clear());
it('preserves uploaded image bytes and consumes the draft only once', async () => {
  await saveSignupImage('draft', new File(['image bytes'], 'cat.png', { type: 'image/png' }));
  const restored = restoreSignupImage('draft')!;
  expect(restored.name).toBe('cat.png'); expect(restored.type).toBe('image/png'); expect(restored.size).toBe(11);
  expect(restoreSignupImage('draft')).toBeNull();
});
it.each(['{', '{}', '{"name":"cat","type":"image/png","base64":"?"}'])('ignores a malformed saved draft: %s', raw => {
  sessionStorage.setItem('draft', raw); expect(restoreSignupImage('draft')).toBeNull();
});
it('reports storage failures so sign-in cannot discard an image', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded'); });
  await expect(saveSignupImage('draft', new File(['a'], 'a.png'))).rejects.toThrow('Quota exceeded');
});
