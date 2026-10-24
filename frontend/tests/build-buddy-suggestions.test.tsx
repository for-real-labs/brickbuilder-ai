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
  expect(container.querySelectorAll('.pet-chat-message--user')).toHaveLength(0);
  expect(container.querySelectorAll('.pet-chat-message:not(.pet-chat-message--user)')).toHaveLength(1);
  expect(input().value).toBe('');
  expect(Array.from(container.querySelectorAll<HTMLButtonElement>('.pet-dialogue button')).some(button => button.textContent === 'Go back')).toBe(true);
});

it('returns a casual chat to the welcome dialogue without starting a build', async () => {
  vi.mocked(BuildBuddyApi.classify).mockResolvedValue({ intent: 'chat', confidence: 1 });
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('.pet-dialogue button')?.textContent).not.toBe('Go back');
  type('Hi'); await submit();
  expect(container.querySelector('.pet-dialogue')?.textContent).toContain('That sounds fun!');
  expect(container.querySelector('.pet-chat-message .pet-chat-bubble button')?.textContent).toBe('Go back');
  expect(container.querySelector('.pet-dialogue > .pet-dialogue-content > button')).toBeNull();
  act(() => Array.from(container.querySelectorAll<HTMLButtonElement>('.pet-dialogue button'))
    .find(button => button.textContent === 'Go back')!.click());
  expect(container.querySelector('.landing-hero-pet .pet-avatar')).not.toBeNull();
  expect(container.querySelector('.pet-dialogue')).toBeNull();
  expect(container.querySelector('.pet-dialogue')?.textContent || '').not.toContain('That sounds fun!');
  expect(container.querySelector('.landing-page--conversation-started')).toBeNull();
  expect(input().value).toBe('');
  expect(NovaToBricksApiService.generate).not.toHaveBeenCalled();
  expect(posthog.capture).toHaveBeenCalledWith('landing_chat_back_clicked', { surface: 'pet_dialogue' });
});

it('routes a natural upload command to the shared image-picker action', async () => {
  vi.mocked(BuildBuddyApi.classify).mockResolvedValue({ intent: 'upload', confidence: 1 });
  await act(async () => root.render(<LandingPage />));
  type('Let me upload a photo'); await submit();
  const picker = vi.spyOn(container.querySelector<HTMLInputElement>('input[type="file"]')!, 'click');
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Upload image"]')!.click());
  expect(picker).toHaveBeenCalledOnce();
  expect(BuildBuddyApi.reply).not.toHaveBeenCalled();
  expect(NovaToBricksApiService.generate).not.toHaveBeenCalled();
});

it.each(['castle', 'Create a red fox in LEGO'])('starts exactly one build for the generation intent "%s"', async message => {
  await act(async () => root.render(<LandingPage />));
  type(message); await submit();
  expect(NovaToBricksApiService.generate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prompt: message }), undefined);
  expect(container.querySelectorAll('.pet-chat-message--user')).toHaveLength(0);
  expect(container.querySelector('[aria-label="Generation in progress actions"]')).not.toBeNull();
  expect(Array.from(container.querySelectorAll<HTMLButtonElement>('.pet-dialogue button')).some(button => button.textContent === 'Go back')).toBe(false);
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
  expect(container.textContent).toContain('Can you try again?');
  expect(container.textContent).not.toContain('private upstream');
  expect(NovaToBricksApiService.generate).not.toHaveBeenCalled();
});

it('docks the dialogue after user input while hiding the restored headline and stats', async () => {
  await act(async () => root.render(<LandingPage />));
  const page = container.querySelector('.landing-page')!;
  const dialogue = container.querySelector('.landing-model-conversation')!;
  expect(page.classList.contains('landing-page--conversation-started')).toBe(false);
  expect(container.querySelector('.landing-page-intro')?.getAttribute('aria-hidden')).toBe('false');
  expect(container.querySelector('h1')?.textContent).toBe('The Easiest Way to Make LEGO');
  act(() => input().focus());
  await submit();
  expect(page.classList.contains('landing-page--conversation-started')).toBe(false);
  type(IMAGE_PROMPT_SUGGESTION);
  expect(page.classList.contains('landing-page--conversation-started')).toBe(false);
  await submit();
  expect(page.classList.contains('landing-page--conversation-started')).toBe(true);
  expect(container.querySelector('.landing-model-conversation')).toBe(dialogue);
  expect(container.querySelector('.landing-page-intro')?.getAttribute('aria-hidden')).toBe('true');
  expect(container.querySelector('.landing-page > .landing-page-shell > header')).not.toBeNull();
  expect(container.querySelector('.landing-model-conversation form')).not.toBeNull();
  expect(container.querySelector('[role="log"]')?.textContent).toContain('Tap Upload image');
  act(() => input().blur());
  expect(container.querySelector('.landing-page-intro')?.getAttribute('aria-hidden')).toBe('true');
});

it.each([undefined, 'photo-to-lego'] as const)('removes suggestion buttons and submits typed build ideas on %s', async imageLandingPath => {
  await act(async () => root.render(<LandingPage imageLandingPath={imageLandingPath} />));
  expect(container.querySelector('[aria-label="Build suggestions"]')).toBeNull();
  const expected = `Create ${PROMPT_EXAMPLES[0]} out of LEGO`;
  type(expected);
  await submit();
  expect(container.querySelector('.landing-page-intro')?.getAttribute('aria-hidden')).toBe('true');
  expect(container.querySelector('.pet-chat-message--user')).toBeNull();
  expect(container.querySelector('[aria-label="Generation in progress actions"]')).not.toBeNull();
  expect(NovaToBricksApiService.generate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prompt: expected, imageBase64: undefined }), undefined);
  expect(BuildBuddyApi.reply).toHaveBeenCalledWith(expect.objectContaining({ prompt: expected }), undefined, expect.any(AbortSignal));
});

it('uses a muted idea placeholder on the welcome screen and the compact composer after chatting', async () => {
  vi.mocked(BuildBuddyApi.classify).mockResolvedValue({ intent: 'question', confidence: 1 });
  await act(async () => root.render(<LandingPage />));
  expect(input().placeholder).toBe('Describe your idea');
  expect(input().getAttribute('aria-label')).toBe('Describe your model');
  expect(container.querySelector('.landing-empty-input-caret')).toBeNull();
  act(() => input().focus());
  type('My own idea');
  expect(input().placeholder).toBe('Describe your idea');
  expect(container.querySelector('.landing-page--welcome')).not.toBeNull();
  await submit();
  expect(input().placeholder).toBe('');
  act(() => input().blur());
  expect(container.querySelector('.landing-empty-input-caret')).not.toBeNull();
});

it('resets a Safari back-cache visit to a fresh greeting and a plain prompt', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.useFakeTimers();
  vi.mocked(BuildBuddyApi.classify).mockResolvedValue({ intent: 'chat', confidence: 1 });
  vi.mocked(BuildBuddyApi.reply).mockResolvedValue('That sounds fun! What colors do you like?');
  try {
    await act(async () => root.render(<LandingPage />));
    type('An old castle conversation'); await submit();
    expect(container.querySelector('.landing-page--conversation-started')).not.toBeNull();
    expect(container.querySelector('[role="log"]')?.textContent).toContain('That sounds fun!');
    const restored = new Event('pageshow');
    Object.defineProperty(restored, 'persisted', { value: true });
    await act(async () => window.dispatchEvent(restored));
    expect(container.querySelector('.landing-page--conversation-started')).toBeNull();
    expect(container.querySelector('.pet-chat-message--user')).toBeNull();
    expect(container.textContent).not.toContain('An old castle conversation');
    expect(input().value).toBe('');
    for (let i = 0; i < 6; i++) await act(async () => { await vi.advanceTimersByTimeAsync(70); });
    expect(input().placeholder).toBe('Describe your idea');
    expect(posthog.capture).toHaveBeenCalledWith('landing_visit_reset', { source: 'history_restore' });
  } finally { vi.useRealTimers(); }
});

it('cancels replies from the previous cached visit and ignores a late response', async () => {
  vi.mocked(BuildBuddyApi.classify).mockResolvedValue({ intent: 'chat', confidence: 1 });
  let respond!: (text: string) => void;
  vi.mocked(BuildBuddyApi.reply).mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }));
  await act(async () => root.render(<LandingPage />));
  type('Old pending message'); await submit();
  const signal = vi.mocked(BuildBuddyApi.reply).mock.calls[0][2];
  const restored = new Event('pageshow');
  Object.defineProperty(restored, 'persisted', { value: true });
  await act(async () => window.dispatchEvent(restored));
  expect(signal.aborted).toBe(true);
  await act(async () => respond('An old reply that must stay cleared'));
  expect(container.textContent).not.toContain('An old reply that must stay cleared');
  expect(container.querySelector('.landing-page--conversation-started')).toBeNull();
});

it('derives a single useful next step from gifts, uploads, model edits and the latest topic', () => {
  expect(buddyPromptSuggestion([{ id: 1, text: 'Gift', kind: 'gift', buildPrompt: 'A LEGO garden for Mum' }], 'Pip')).toBe('A LEGO garden for Mum');
  expect(buddyPromptSuggestion([{ id: 1, text: 'Upload', kind: 'upload' }], 'Pip')).toContain('image');
  expect(buddyPromptSuggestion([{ id: 1, text: 'Castle' }], 'Pip', 'Add a drawbridge')).toBe('Add a drawbridge');
  expect(buddyPromptSuggestion([{ id: 1, text: 'Castle', reply: 'What colors would you like?' }], 'Pip', 'Add a drawbridge')).toBe('What colors would you like?');
  expect(buddyPromptSuggestion([{ id: 1, text: 'Red  dragons!' }], 'Pip')).toBe('Tell me more about “Red dragons”…');
  expect(buddyPromptSuggestion([{ id: 1, text: 'Castle', error: 'Failed' }], 'Pip')).toBe('Try your message again…');
});

it('plans a gift with follow-up context, blocks duplicate sends, and accepts a typed request to build the idea', async () => {
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
  expect(container.querySelector('.pet-chat-action')?.textContent).toBe('Go back');
  vi.mocked(BuildBuddyApi.classify).mockResolvedValueOnce({ intent: 'generate', confidence: 1 });
  type('Build a LEGO garden with sunflowers and a purple bench for Mum’s birthday');
  await submit();
  expect(NovaToBricksApiService.generate).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Build a LEGO garden with sunflowers and a purple bench for Mum’s birthday' }), undefined);
});

it.each([true, false])('gives device-appropriate upload guidance (desktop: %s) with a return action', async desktop => {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: desktop && query.includes('pointer: fine'), addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  await act(async () => root.render(<LandingPage />));
  type(IMAGE_PROMPT_SUGGESTION);
  await submit();
  const dialogue = container.querySelector('[role="log"]')!;
  expect(dialogue.textContent).toContain(desktop ? 'click Upload image below.' : 'Tap Upload image below');
  expect(dialogue.textContent?.includes('Drop a picture here')).toBe(desktop);
  const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const pick = vi.spyOn(picker, 'click');
  expect([...dialogue.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Go back']);
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Upload image"]')!.click());
  expect(pick).toHaveBeenCalledOnce();
  expect(posthog.capture).toHaveBeenCalledWith('landing_image_picker_opened', { page: '/', upload_position: 'input_left_icon' });
  expect(BuildBuddyApi.reply).not.toHaveBeenCalled();
  expect(NovaToBricksApiService.generate).not.toHaveBeenCalled();
});

it('recovers from a gift chat failure without starting a build and starts a fresh gift conversation on reselect', async () => {
  const plan = vi.spyOn(BuildBuddyApi, 'planGift').mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ reply: 'Who is it for?' });
  await act(async () => root.render(<LandingPage />));
  type(GIFT_PROMPT_SUGGESTION);
  await submit();
  expect(container.textContent).toContain('Can you send it again?');
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  type('My dad'); await submit();
  type(GIFT_PROMPT_SUGGESTION);
  await submit();
  expect(plan.mock.calls[2][0].history).toEqual([]);
  expect(NovaToBricksApiService.generate).not.toHaveBeenCalled();
});

it('routes a pet download request to the tool and shows its missing-model error', async () => {
 vi.mocked(BuildBuddyApi.classify).mockResolvedValue({ intent: 'export_csv', confidence: 0.95 });
 await act(async () => root.render(<LandingPage />));
 type('Download my parts as CSV'); await submit();
 expect(container.textContent).toContain('Open or create a model first');
 expect(BuildBuddyApi.reply).not.toHaveBeenCalled();
 expect(NovaToBricksApiService.generate).not.toHaveBeenCalled();
 expect(posthog.capture).toHaveBeenCalledWith('build_buddy_tool_failed', expect.objectContaining({ action: 'export_csv' }));
});
