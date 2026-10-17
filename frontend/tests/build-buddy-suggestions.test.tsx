import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import LandingPage from '../src/pages/LandingPage';
import { BuildBuddyApi } from '../src/services/buildBuddyApi';
import { NovaToBricksApiService } from '../src/services/novaToBricksApi';
import { GetGenerationApiService } from '../src/services/getGenerationApi';
import { GIFT_PROMPT_SUGGESTION, IMAGE_PROMPT_SUGGESTION, PROMPT_EXAMPLES } from '../src/utils/promptExamples';
import { buddyPromptSuggestion } from '../src/utils/buddyPromptSuggestion';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn(), useSearchParams: () => [new URLSearchParams(), vi.fn()] }));
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
  vi.spyOn(BuildBuddyApi, 'classify').mockImplementation(async ({ prompt, giftPlanning }) => ({
    intent: prompt === IMAGE_PROMPT_SUGGESTION ? 'upload' : prompt === GIFT_PROMPT_SUGGESTION || giftPlanning ? 'gift' : 'generate', confidence: 1,
  }));
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

it.each([
  { message: 'How do you choose the bricks?', intent: 'question' },
  { message: 'Hi Pip, how are you?', intent: 'chat' },
  { message: 'Do something', intent: 'clarify' },
] as const)('replies to "$message" without generating a model', async ({ message, intent }) => {
  vi.mocked(BuildBuddyApi.classify).mockResolvedValue({ intent, confidence: 0.95 });
  await act(async () => root.render(<LandingPage />));
  type(message); await submit();
  expect(BuildBuddyApi.classify).toHaveBeenCalledWith(expect.objectContaining({ prompt: message, hasImage: false }), undefined, expect.any(AbortSignal));
  expect(BuildBuddyApi.reply).toHaveBeenCalledWith(expect.objectContaining({ prompt: message, intent }), undefined, expect.any(AbortSignal));
  expect(NovaToBricksApiService.generate).not.toHaveBeenCalled();
  expect(container.querySelectorAll('.pet-chat-message--user')).toHaveLength(1);
  expect(input().value).toBe('');
});

it('routes a natural upload command to the shared image-picker action', async () => {
  vi.mocked(BuildBuddyApi.classify).mockResolvedValue({ intent: 'upload', confidence: 1 });
  await act(async () => root.render(<LandingPage />));
  type('Let me upload a photo'); await submit();
  const picker = vi.spyOn(container.querySelector<HTMLInputElement>('input[type="file"]')!, 'click');
  act(() => container.querySelector<HTMLButtonElement>('[role="log"] button')!.click());
  expect(picker).toHaveBeenCalledOnce();
  expect(BuildBuddyApi.reply).not.toHaveBeenCalled();
  expect(NovaToBricksApiService.generate).not.toHaveBeenCalled();
});

it.each(['castle', 'Create a red fox in LEGO'])('starts exactly one build for the generation intent "%s"', async message => {
  await act(async () => root.render(<LandingPage />));
  type(message); await submit();
  expect(NovaToBricksApiService.generate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prompt: message }), undefined);
  expect(container.querySelectorAll('.pet-chat-message--user')).toHaveLength(1);
});

it('blocks duplicate routing and keeps the prompt recoverable when Jev is unavailable', async () => {
  let reject!: (error: Error) => void;
  vi.mocked(BuildBuddyApi.classify).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  await act(async () => root.render(<LandingPage />));
  type('castle'); await submit(); await submit();
  expect(BuildBuddyApi.classify).toHaveBeenCalledOnce();
  expect(input().disabled).toBe(true);
  await act(async () => reject(new Error('private upstream body')));
  expect(input().disabled).toBe(false);
  expect(input().value).toBe('castle');
  expect(container.textContent).toContain('Please send it again');
  expect(container.textContent).not.toContain('private upstream');
  expect(NovaToBricksApiService.generate).not.toHaveBeenCalled();
});

it('docks the dialogue and fades the intro only after a user message is submitted', async () => {
  await act(async () => root.render(<LandingPage />));
  const intro = container.querySelector('.landing-page-intro')!;
  const page = container.querySelector('.landing-page')!;
  const dialogue = container.querySelector('.landing-model-conversation')!;
  expect(page.classList.contains('landing-page--conversation-started')).toBe(false);
  expect(intro.getAttribute('aria-hidden')).toBe('false');
  expect(intro.querySelector('h1')?.textContent).toContain('Imagine. Create. Build.');
  expect(intro.querySelector('[aria-label="BrickBuilder generation statistics"]')).not.toBeNull();
  act(() => input().focus());
  await submit();
  expect(page.classList.contains('landing-page--conversation-started')).toBe(false);
  type(IMAGE_PROMPT_SUGGESTION);
  expect(page.classList.contains('landing-page--conversation-started')).toBe(false);
  expect(intro.getAttribute('aria-hidden')).toBe('false');
  await submit();
  expect(page.classList.contains('landing-page--conversation-started')).toBe(true);
  expect(container.querySelector('.landing-model-conversation')).toBe(dialogue);
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
    expect(input().placeholder).toBe('Tell Pip more about your idea…');
    type('');
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(input().placeholder).toBe('Tell Pip more about your idea…');
  } finally { vi.useRealTimers(); }
});

it('keeps one conversational hint after chatting and brings cycling examples back on reload', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.useFakeTimers();
  vi.mocked(BuildBuddyApi.classify).mockResolvedValue({ intent: 'question', confidence: 1 });
  vi.mocked(BuildBuddyApi.reply).mockResolvedValue('I can help you pick bricks. What colors would you like for your castle?');
  try {
    await act(async () => root.render(<LandingPage />));
    type('Can you help me choose bricks for a castle?'); await submit();
    act(() => input().blur());
    expect(input().placeholder).toBe('What colors would you like for your castle?');
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(input().placeholder).toBe('What colors would you like for your castle?');
    expect(posthog.capture).toHaveBeenCalledWith('build_buddy_contextual_suggestion_shown');
    expect(vi.mocked(posthog.capture).mock.calls.filter(call => call[0] === 'build_buddy_contextual_suggestion_shown')).toHaveLength(1);
    vi.mocked(BuildBuddyApi.reply).mockResolvedValue('Blue and gold will work well. Would you like a blue roof?');
    type('Blue and gold'); await submit();
    expect(input().placeholder).toBe('Would you like a blue roof?');
    act(() => root.unmount()); root = createRoot(container);
    await act(async () => root.render(<LandingPage />));
    for (let i = 0; i < 6; i++) await act(async () => { await vi.advanceTimersByTimeAsync(70); });
    expect(input().placeholder.replace('|', '')).toBe('Create');
    expect(container.querySelector('.pet-chat-message--user')).toBeNull();
  } finally { vi.useRealTimers(); }
});

it('derives a single useful next step from gifts, uploads, model edits and the latest topic', () => {
  expect(buddyPromptSuggestion([{ id: 1, text: 'Gift', kind: 'gift', buildPrompt: 'A LEGO garden for Mum' }], 'Pip')).toBe('A LEGO garden for Mum');
  expect(buddyPromptSuggestion([{ id: 1, text: 'Upload', kind: 'upload' }], 'Pip')).toContain('image');
  expect(buddyPromptSuggestion([{ id: 1, text: 'Castle' }], 'Pip', 'Add a drawbridge')).toBe('Add a drawbridge');
  expect(buddyPromptSuggestion([{ id: 1, text: 'Castle', reply: 'What colors would you like?' }], 'Pip', 'Add a drawbridge')).toBe('What colors would you like?');
  expect(buddyPromptSuggestion([{ id: 1, text: 'Red  dragons!' }], 'Pip')).toBe('Tell me more about “Red dragons”…');
  expect(buddyPromptSuggestion([{ id: 1, text: 'Castle', error: 'Failed' }], 'Pip')).toBe('Try your message again…');
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
