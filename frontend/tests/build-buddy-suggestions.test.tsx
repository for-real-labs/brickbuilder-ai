import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import LandingPage from '../src/pages/LandingPage';
import { BuildBuddyApi } from '../src/services/buildBuddyApi';
import { NovaToBricksApiService } from '../src/services/novaToBricksApi';
import { GetGenerationApiService } from '../src/services/getGenerationApi';
import { GIFT_PROMPT_SUGGESTION, IMAGE_PROMPT_SUGGESTION, PROMPT_EXAMPLES } from '../src/utils/promptExamples';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => ({ session: null, loading: false }) }));
vi.mock('../src/hooks/useGenerationActivity', async () => ({
  ...await vi.importActual('../src/hooks/useGenerationActivity'),
  useGenerationActivity: () => ({ generations: [], trackGeneration: vi.fn(), dismissGeneration: vi.fn() }),
}));
vi.mock('../src/services/localProvidersApi', () => ({ isLocalDevelopment: () => false }));
vi.mock('../src/services/getGenerationStatsApi', () => ({ GetGenerationStatsApiService: { getGenerationStats: async () => ({ generation_count: 0, brick_count: 0 }) } }));
vi.mock('../src/services/getCommunityGenerationsApi', () => ({ GetCommunityGenerationsApiService: { getCommunityGenerations: async () => ({ generations: [] }) } }));
vi.mock('../src/components/FallingBricks', () => ({ default: () => null }));
vi.mock('../src/components/SEO', () => ({ SEO: () => null }));
vi.mock('../src/components/LoginModal', () => ({ default: () => null }));
vi.mock('../src/components/SiteFooter', () => ({ SiteFooter: () => null }));
vi.mock('../src/components/ProfileMenu', () => ({ ProfileMenu: () => null }));
vi.mock('../src/components/NotificationMenu', () => ({ NotificationMenu: () => null }));
vi.mock('../src/components/GenerationActivityList', () => ({ GenerationActivityList: () => null }));
vi.mock('../src/components/StreamingMeshViewer', () => ({ default: () => null }));

let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ stargazers_count: 0 }) } as Response);
  vi.spyOn(BuildBuddyApi, 'reply').mockResolvedValue('That sounds fun!');
  vi.spyOn(NovaToBricksApiService, 'generate').mockResolvedValue({ generation_id: 'job', message: 'Started' });
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue({ generation_id: 'job', status: 'processing' } as never);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const input = () => container.querySelector<HTMLInputElement>('#landing-build-prompt')!;
function type(text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const submit = () => act(async () => container.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

it('fades the headline and statistics after the first message while keeping the header and dialogue mounted', async () => {
  await act(async () => root.render(<LandingPage />));
  const intro = container.querySelector('.landing-page-intro')!;
  expect(intro.getAttribute('aria-hidden')).toBe('false');
  expect(intro.querySelector('h1')?.textContent).toContain('Imagine. Create. Build.');
  expect(intro.querySelector('[aria-label="BrickBuilder generation statistics"]')).not.toBeNull();
  act(() => input().focus());
  type(IMAGE_PROMPT_SUGGESTION);
  expect(intro.getAttribute('aria-hidden')).toBe('false');
  await submit();
  expect(intro.getAttribute('aria-hidden')).toBe('true');
  expect(intro.classList.contains('landing-page-intro--hidden')).toBe(true);
  expect(container.querySelector('.landing-page > .landing-page-shell > header')).not.toBeNull();
  expect(container.querySelector('.landing-model-conversation form')).not.toBeNull();
  expect(container.querySelector('[role="log"]')?.textContent).toContain(IMAGE_PROMPT_SUGGESTION);
  act(() => input().blur());
  expect(intro.getAttribute('aria-hidden')).toBe('true');
});

it.each([undefined, 'photo-to-lego'] as const)('removes suggestion buttons and submits typed build ideas on %s', async imageLandingPath => {
  await act(async () => root.render(<LandingPage imageLandingPath={imageLandingPath} />));
  expect(container.querySelector('[aria-label="Build suggestions"]')).toBeNull();
  const expected = `Create ${PROMPT_EXAMPLES[0]} out of LEGO`;
  type(expected);
  await submit();
  expect(container.querySelector('.landing-page-intro')?.getAttribute('aria-hidden')).toBe('true');
  expect(container.querySelector('.pet-chat-message--user')?.textContent).toContain(expected);
  expect(NovaToBricksApiService.generate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prompt: expected, imageBase64: undefined }), undefined);
  expect(BuildBuddyApi.reply).toHaveBeenCalledWith(expect.objectContaining({ prompt: expected }), undefined, expect.any(AbortSignal));
});

it('animates the empty landing input and stops while the user focuses or types', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.useFakeTimers();
  try {
    await act(async () => root.render(<LandingPage />));
    for (let i = 0; i < 6; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(70); });
    }
    expect(input().placeholder.replace('|', '')).toBe('Create');
    expect(input().value).toBe('');
    act(() => input().focus());
    expect(input().placeholder).toBe('Tell Pip what you’d like to build…');
    type('My own idea');
    act(() => input().blur());
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(input().value).toBe('My own idea');
    expect(input().placeholder).toBe('Tell Pip what you’d like to build…');
  } finally { vi.useRealTimers(); }
});

it('plans a gift with follow-up context, blocks duplicate sends, and hands a complete idea back to Create', async () => {
  let respond!: (value: { reply: string }) => void;
  const plan = vi.spyOn(BuildBuddyApi, 'planGift').mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }))
    .mockResolvedValueOnce({ reply: 'A tiny garden with a purple bench would be lovely. Want to change anything?', buildPrompt: 'A LEGO garden with sunflowers and a purple bench for Mum’s birthday' });
  await act(async () => root.render(<LandingPage />));
  type(GIFT_PROMPT_SUGGESTION);
  await submit();
  expect(input().value).toBe('');
  expect(container.querySelector('button[type="submit"]')?.getAttribute('aria-label')).toBe('Send');
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  type('Mum loves gardening'); await submit();
  expect(plan).toHaveBeenCalledTimes(1);
  await act(async () => respond({ reply: 'Who is the gift for, and what do they love?' }));
  await submit();
  expect(plan.mock.calls[1][0]).toEqual({ pet: 'pip', prompt: 'Mum loves gardening', history: [
    { role: 'user', text: GIFT_PROMPT_SUGGESTION },
    { role: 'assistant', text: 'Who is the gift for, and what do they love?' },
  ] });
  expect(NovaToBricksApiService.generate).not.toHaveBeenCalled();
  expect(posthog.capture).toHaveBeenCalledWith('build_buddy_suggestion_submitted', { suggestion: 'gift' });
  expect(BuildBuddyApi.reply).not.toHaveBeenCalled();
  const useIdea = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Use this gift idea')!;
  act(() => useIdea.click());
  expect(input().value).toContain('purple bench');
  expect(document.activeElement).toBe(input());
  expect(container.querySelector('button[type="submit"]')?.getAttribute('aria-label')).toBe('Create');
  await submit();
  expect(NovaToBricksApiService.generate).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'A LEGO garden with sunflowers and a purple bench for Mum’s birthday' }), undefined);
  expect(posthog.capture).toHaveBeenCalledWith('build_buddy_gift_idea_selected');
});

it.each([true, false])('gives device-appropriate upload guidance (desktop: %s) and opens the shared picker from the pet reply', async desktop => {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: desktop && query.includes('pointer: fine'), addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  await act(async () => root.render(<LandingPage />));
  type(IMAGE_PROMPT_SUGGESTION);
  await submit();
  const dialogue = container.querySelector('[role="log"]')!;
  expect(dialogue.textContent).toContain('click the Upload image button below'.replace(/^c/, desktop ? 'c' : 'C'));
  expect(dialogue.textContent?.includes('Drag and drop')).toBe(desktop);
  const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const pick = vi.spyOn(picker, 'click');
  act(() => dialogue.querySelector<HTMLButtonElement>('button')!.click());
  expect(pick).toHaveBeenCalledOnce();
  expect(posthog.capture).toHaveBeenCalledWith('landing_image_picker_opened', { page: '/', upload_position: 'buddy_dialogue' });
  expect(BuildBuddyApi.reply).not.toHaveBeenCalled();
  expect(NovaToBricksApiService.generate).not.toHaveBeenCalled();
});

it('recovers from a gift chat failure without starting a build and starts a fresh gift conversation on reselect', async () => {
  const plan = vi.spyOn(BuildBuddyApi, 'planGift').mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ reply: 'Who is it for?' });
  await act(async () => root.render(<LandingPage />));
  type(GIFT_PROMPT_SUGGESTION);
  await submit();
  expect(container.textContent).toContain('Please send your answer again');
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  type('My dad'); await submit();
  type(GIFT_PROMPT_SUGGESTION);
  await submit();
  expect(plan.mock.calls[2][0].history).toEqual([]);
  expect(NovaToBricksApiService.generate).not.toHaveBeenCalled();
});
