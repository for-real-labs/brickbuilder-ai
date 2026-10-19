import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import LandingPage from '../src/pages/LandingPage';
import { GetGenerationApiService, type GetGenerationResponse } from '../src/services/getGenerationApi';
import { LdrToMpdApiService } from '../src/services/ldrToMpdApi';
import { NovaToBricksApiService } from '../src/services/novaToBricksApi';
import { LlmToBricksApiService } from '../src/services/llmToBricksApi';
import { useLandingModel, type LandingModel } from '../src/hooks/useLandingModel';
import type { GenerationActivity } from '../src/hooks/useGenerationActivity';
import { BuildBuddyApi } from '../src/services/buildBuddyApi';
import { GetPriceApiService } from '../src/services/getPriceApi';
import { GenerationEmailApi } from '../src/services/generationEmailApi';
import { GetUserGenerationsApiService, type GenerationWithOrder } from '../src/services/getUserGenerationsApi';
import { LandingModelWorkspace, modelEditSuggestion } from '../src/components/LandingModelWorkspace';

const auth = vi.hoisted(() => ({ isSupabaseConfigured: false }));
const activity = vi.hoisted(() => ({ rows: [] as GenerationActivity[], track: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => ({ value: '', set: vi.fn() }));
const buddy = vi.hoisted(() => ({ updateTurn: vi.fn() }));
const viewer = vi.hoisted(() => ({ loaded: undefined as undefined | (() => void), markViewed: vi.fn() }));
const inbox = vi.hoisted(() => ({ notifications: [] as import('../src/services/generationNotificationsApi').ModelNotification[] }));
vi.mock('../src/contexts/GenerationNotificationsContext', () => ({ useGenerationNotifications: () => ({ notifications: inbox.notifications, unread_count: inbox.notifications.length, markViewed: viewer.markViewed }) }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate, useSearchParams: () => [new URLSearchParams(query.value), query.set] }));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => ({ session: null, loading: false, ...auth }) }));
vi.mock('../src/hooks/useGenerationActivity', async () => ({
  ...await vi.importActual('../src/hooks/useGenerationActivity'),
  useGenerationActivity: () => ({ generations: activity.rows, trackGeneration: activity.track, dismissGeneration: vi.fn() }),
}));
vi.mock('../src/services/localProvidersApi', () => ({ isLocalDevelopment: () => false }));
vi.mock('../src/hooks/useBuildBuddyChat', () => ({ useBuildBuddyChat: () => ({ turns: [], startTurn: () => 1,
  routing: false, routeMessage: async () => ({ id: 1, intent: 'generate', confidence: 1 }),
  requestReply: vi.fn(), updateTurn: buddy.updateTurn, resetConversation: vi.fn() }) }));
vi.mock('../src/services/getGenerationStatsApi', () => ({ GetGenerationStatsApiService: { getGenerationStats: async () => ({ generation_count: 1, brick_count: 100 }) } }));
vi.mock('../src/services/getCommunityGenerationsApi', () => ({ GetCommunityGenerationsApiService: { getCommunityGenerations: async () => ({ generations: [] }) } }));
vi.mock('../src/pages/InstructionsPage', () => ({ InstructionsViewer: () => <div>Building instructions<div className="instructions-canvas"><canvas /></div><div className="instructions-parts">Parts list</div></div> }));
vi.mock('../src/components/ThreeLDRViewer', () => ({ ThreeLDRViewer: ({ modelContent, modelName, modelPath, onModelLoaded }: { modelContent?: string; modelName?: string; modelPath?: string; onModelLoaded?: () => void }) => {
  if (modelPath) return <div data-testid="generation-3d-animation" data-scene={modelPath} />;
  viewer.loaded = onModelLoaded;
  return <div data-testid="viewer" data-model-name={modelName}>{modelContent}</div>;
} }));
vi.mock('../src/components/FallingBricks', () => ({ default: () => null }));
vi.mock('../src/components/SEO', () => ({ SEO: () => null }));
vi.mock('../src/components/LoginModal', () => ({ default: () => null }));
vi.mock('../src/components/SiteFooter', () => ({ SiteFooter: () => null }));
vi.mock('../src/components/ProfileMenu', () => ({ ProfileMenu: () => null }));
vi.mock('../src/components/NotificationMenu', () => ({ NotificationMenu: () => null }));
vi.mock('../src/components/StreamingMeshViewer', () => ({ default: () => null }));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const generation = (id: string, endpoint = 'novaToBricks'): GetGenerationResponse => ({
  generation_id: id, status: 'completed', endpoint, prompt: 'A castle', name: 'Castle',
  example_edit_prompt: 'Add a drawbridge', mpd_url: '/castle.mpd', ldr_content: 'castle ldr',
  external_image_url: null, processed_image_url: null, detail_level: 40,
  xyzrgb_url: null, problematic_xyzrgb_url: null, error_message: null,
});
const historyBuild = (id: string, prompt: string, created_at = '2026-10-18'): GenerationWithOrder => ({
  id, prompt, created_at, status: 'completed', user_id: 'guest', user_type: 'anonymous',
  detail_level: 40, endpoint: 'novaToBricks',
});
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'show', { configurable: true, value: vi.fn(function(this: HTMLDialogElement) { this.open = true; }) });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn(function(this: HTMLDialogElement) { this.open = true; }) });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: vi.fn(function(this: HTMLDialogElement) { this.open = false; }) });
  auth.isSupabaseConfigured = false;
  buddy.updateTurn.mockClear();
  viewer.loaded = undefined;
  viewer.markViewed.mockReset().mockResolvedValue(undefined);
  inbox.notifications = [];
  window.history.replaceState(null, '', '/');
  navigate.mockClear();
  query.value = '';
  query.set.mockReset();
  query.set.mockImplementation(next => { query.value = next(new URLSearchParams(query.value)).toString(); });
  vi.spyOn(GetPriceApiService, 'getPrice').mockResolvedValue({ generation_id: 'castle', total_price: 44.77, total_weight: .5263, total_parts: 370, currency: 'USD', parts_breakdown: [] } as never);
  vi.spyOn(GenerationEmailApi, 'status').mockResolvedValue({ subscribed: false, email: null });
  vi.spyOn(LlmToBricksApiService, 'watchOutput').mockResolvedValue(true);
  vi.spyOn(GetUserGenerationsApiService, 'getUserGenerations').mockResolvedValue({
    generations: [], total_count: 0, total_user_generations: 0, all_orders: [], has_more: false,
  });
  sessionStorage.clear();
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => 'castle mpd', json: async () => ({ stargazers_count: 0 }) })));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  activity.rows = [];
  activity.track.mockImplementation(row => { activity.rows = [row, ...activity.rows]; });
});
afterEach(() => { act(() => root.unmount()); container.remove(); window.history.replaceState(null, '', '/'); vi.useRealTimers(); vi.unstubAllGlobals(); });
const input = () => container.querySelector<HTMLInputElement>('#landing-build-prompt')!;
function type(text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const submit = () => act(async () => container.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

it('keeps the landing dialogue in the centered layout while typing and after clearing the input', async () => {
  await act(async () => root.render(<LandingPage />));
  const shell = container.querySelector('.landing-page')!;
  expect(shell.classList.contains('landing-page--conversation-started')).toBe(false);
  act(() => input().focus());
  expect(shell.classList.contains('landing-page--conversation-started')).toBe(false);
  type('A little castle');
  expect(shell.classList.contains('landing-page--conversation-started')).toBe(true);
  expect(shell.querySelector('.landing-model-workspace, .landing-generation-workspace')).toBeNull();
  expect(shell.querySelector('.landing-model-conversation')).not.toBeNull();
  type('');
  expect(shell.classList.contains('landing-page--conversation-started')).toBe(true);
});

it('keeps the landing headline and stats visible while the prompt is focused', async () => {
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('[aria-label="BrickBuilder generation statistics"]')).not.toBeNull();
  expect(container.textContent).toContain('Imagine. Create. Build.');
  act(() => input().focus());
  expect(container.querySelector('[aria-label="BrickBuilder generation statistics"]')).not.toBeNull();
  act(() => input().blur());
  expect(container.querySelector('[aria-label="BrickBuilder generation statistics"]')).not.toBeNull();
});

it('starts docked for a generation URL before the model finishes loading', async () => {
  query.value = 'id=castle';
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockReturnValue(new Promise(() => {}));
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('.landing-page--conversation-started')).not.toBeNull();
  expect(container.querySelector('.landing-page-intro')?.getAttribute('aria-hidden')).toBe('true');
});

it('starts with a choice instead of showing background builds or model cards', async () => {
  sessionStorage.setItem('brickbuilder.landing-model:guest', 'saved-castle');
  activity.rows = [
    { id: 'failed', status: 'failed', endpoint: 'novaToBricks', prompt: 'Old concert stage' },
    { id: 'pending', status: 'processing', endpoint: 'novaToBricks', prompt: 'Background car' },
    { id: 'cancelled', status: 'cancelled', endpoint: 'novaToBricks', prompt: 'Cancelled dragon' },
  ];
  inbox.notifications = [{ id: 'ready', prompt: 'Ready castle', status: 'completed', seen: false, updated_at: '2026-10-17', is_edit: false }];
  vi.mocked(GetUserGenerationsApiService.getUserGenerations).mockResolvedValue({
    generations: [historyBuild('ready', 'Ready castle')], total_count: 1, total_user_generations: 1, all_orders: [], has_more: false,
  });
  const get = vi.spyOn(GetGenerationApiService, 'getGeneration');
  const watch = vi.mocked(LlmToBricksApiService.watchOutput);
  for (let visit = 0; visit < 2; visit++) {
    await act(async () => root.render(<LandingPage />));
    expect(container.querySelector('.pet-dialogue')?.textContent).toContain('What would you like to do?');
    expect(container.querySelector('.pet-dialogue')?.textContent).toContain('Show builds');
    expect(container.querySelector('.pet-dialogue')?.textContent).not.toContain('Want to see them?');
    expect(container.querySelector('.landing-page--conversation-started')).toBeNull();
    expect(container.querySelector('[aria-label="Your current builds"]')).toBeNull();
    expect(input()).not.toBeNull();
    expect(container.querySelector('[aria-label="Your generations"]')).toBeNull();
    expect(container.querySelector('[aria-label="Build progress workspace"]')).toBeNull();
    expect(container.querySelector('.pet-chat-message--user')).toBeNull();
    expect(container.querySelector('[data-testid="viewer"]')).toBeNull();
    expect(container.textContent).not.toContain('Old concert stage');
    expect(container.textContent).not.toContain('Background car');
    expect(container.textContent).not.toContain('Cancelled dragon');
    expect(container.textContent).not.toContain('Oops!');
    expect(container.querySelector('.pet-dialogue')?.textContent).not.toBe('');
    act(() => root.render(null));
  }
  expect(get).not.toHaveBeenCalled();
  expect(watch).not.toHaveBeenCalled();
});

it('shows processing and recent completed builds inside pet dialogue only after Show builds', async () => {
  activity.rows = [{ id: 'working', status: 'processing', endpoint: 'novaToBricks', prompt: 'Rocket' }];
  inbox.notifications = [{ id: 'ready', prompt: 'Ready car', status: 'completed', seen: false,
    updated_at: '2026-10-18', is_edit: false }];
  vi.mocked(GetUserGenerationsApiService.getUserGenerations).mockResolvedValue({
    generations: [historyBuild('ready', 'Ready car')], total_count: 1, total_user_generations: 1, all_orders: [], has_more: false,
  });
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('[aria-label="Your current builds"]')).toBeNull();
  expect(input()).not.toBeNull();
  expect(container.querySelector('[aria-label="Your generations"]')).toBeNull();
  act(() => Array.from(container.querySelectorAll<HTMLButtonElement>('.pet-dialogue button'))
    .find(button => button.textContent === 'Show builds')!.click());
  expect(container.querySelector('.landing-page--conversation-started')).not.toBeNull();
  expect(container.querySelector('.landing-model-workspace, .landing-generation-workspace')).toBeNull();
  const rows = [...container.querySelectorAll('[aria-label="Your current builds"] li')];
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain('Rocket');
  expect(rows[1].textContent).toContain('Ready car');
  expect(container.querySelector('.pet-dialogue')?.contains(rows[0])).toBe(true);
  expect(Array.from(container.querySelectorAll('.pet-chat-message .pet-chat-bubble button')).some(button => button.textContent === 'Go back')).toBe(true);
  expect(container.querySelector('[aria-label="Your generations"]')).toBeNull();
  act(() => Array.from(container.querySelectorAll<HTMLButtonElement>('.pet-dialogue button'))
    .find(button => button.textContent === 'Go back')!.click());
  expect(container.querySelector('[aria-label="Your current builds"]')).toBeNull();
  expect(container.querySelector('.pet-dialogue')?.textContent).toContain('What would you like to do?');
  expect(input().getAttribute('aria-label')).toBe('Describe your model');
});

it('shows the headline and stats on plain landing visits and hides them on model links', async () => {
  query.value = 'id=castle&exact=1';
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue(generation('castle'));
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('[data-testid="viewer"]')).not.toBeNull();
  expect(container.querySelector('.landing-page-intro')?.getAttribute('aria-hidden')).toBe('true');
  act(() => root.render(null));
  query.value = '';
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('[data-testid="viewer"]')).toBeNull();
  expect(container.querySelector('.landing-page-intro')?.getAttribute('aria-hidden')).toBe('false');
});

it('keeps the model name out of the viewer while retaining it for model actions', async () => {
  await act(async () => root.render(<LandingModelWorkspace model={{ generation: generation('castle'), content: 'model' }} busy={false}><div>Conversation</div></LandingModelWorkspace>));
  const stage = container.querySelector('[aria-label="3D model viewer"]')!;
  expect(stage.textContent).not.toContain('Castle');
  expect(stage.querySelector('[data-testid="viewer"]')?.getAttribute('data-model-name')).toBe('Castle');
  expect(container.querySelector('.landing-model-heading')).toBeNull();
});

it('loads the linked model instead of the saved workspace or newest dashboard generation', async () => {
  query.value = 'id=linked%20%26%20model&exact=1';
  sessionStorage.setItem('brickbuilder.landing-model:guest', 'saved');
  activity.rows = [{ id: 'newest', status: 'completed', endpoint: 'novaToBricks', prompt: 'Newest' }];
  const get = vi.spyOn(GetGenerationApiService, 'getGeneration').mockImplementation(async id => ({ ...generation(id), name: id }));
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('[data-testid="viewer"]')?.getAttribute('data-model-name')).toBe('linked & model');
  expect(container.querySelector('.landing-model-heading')).toBeNull();
  expect(container.querySelector('[data-testid="viewer"]')?.textContent).toBe('castle mpd');
  expect(get.mock.calls.every(([id]) => id === 'linked & model')).toBe(true);
  expect(sessionStorage.getItem('brickbuilder.landing-model:guest')).toBe('linked & model');
});

it('loads a different model when the landing link changes and clears the link when creating a new model', async () => {
  query.value = 'id=first&exact=1&campaign=share';
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockImplementation(async id => ({ ...generation(id), name: id }));
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('[data-testid="viewer"]')?.getAttribute('data-model-name')).toBe('first');
  query.value = 'id=second&exact=1&campaign=share';
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('[data-testid="viewer"]')?.getAttribute('data-model-name')).toBe('second');
  act(() => container.querySelector<HTMLButtonElement>('.landing-create-new')!.click());
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('[data-testid="viewer"]')).toBeNull();
  expect(sessionStorage.getItem('brickbuilder.landing-model:guest')).toBeNull();
  expect(query.value).toBe('campaign=share');
});

it('keeps a linked pending model selected until its geometry is ready', async () => {
  query.value = 'id=pending';
  let ready = false;
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockImplementation(async id => ({ ...generation(id), status: ready ? 'completed' : 'processing' }));
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('[data-testid="viewer"]')).toBeNull();
  expect(container.querySelector('[aria-label="Loading your model"]')).toBeNull();
  ready = true;
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(container.querySelector('[data-testid="viewer"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Loading your model"]')).toBeNull();
});

it('shows a completed build without suggestions and resets from the centered header button', async () => {
  vi.spyOn(NovaToBricksApiService, 'generate').mockResolvedValue({ generation_id: 'castle', message: 'Started' });
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue(generation('castle'));
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('[aria-label="Model suggestions"]')).toBeNull();
  type('A castle'); await submit();
  expect(container.querySelector('[data-testid="viewer"]')?.textContent).toBe('castle mpd');
  expect(container.querySelector('[aria-label="Upload image"]')).toBeNull();
  expect(container.querySelector('[aria-label="Model suggestions"]')).toBeNull();
  expect(container.querySelector('.landing-model-order-trigger')).toBeNull();
  const createNew = container.querySelector<HTMLButtonElement>('header .landing-create-new')!;
  expect(createNew.textContent).toBe('Create new');
  expect(createNew.querySelector('.lucide-sparkles')).not.toBeNull();
  expect(createNew.querySelector('span')?.className).not.toContain('hidden');
  act(() => createNew.click());
  expect(container.querySelector('[data-testid="viewer"]')).toBeNull();
  expect(container.querySelector('[aria-label="Build progress workspace"]')).toBeNull();
  expect(container.querySelector('[aria-label="Your generations"]')).toBeNull();
  expect(container.querySelector('.pet-dialogue')?.textContent).toContain('What would you like to do?');
  expect(container.querySelector('.pet-dialogue')?.textContent).toContain('Show builds');
  expect(input().getAttribute('aria-label')).toBe('Describe your model');
  expect(container.querySelector('[aria-label="Upload image"]')).not.toBeNull();
  expect(input().value).toBe('');
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(container.querySelector('[aria-label="Model suggestions"]')).toBeNull();
  expect(posthog.capture).toHaveBeenCalledWith('landing_model_create_new_clicked', { generation_id: 'castle' });
});

it('offers recent completed builds after Create new, including viewed ones, with processing first', async () => {
  query.value = 'id=castle&exact=1';
  activity.rows = [{ id: 'working', status: 'processing', endpoint: 'novaToBricks', prompt: 'Rocket', createdAt: '2026-10-19' }];
  inbox.notifications = [
    { id: 'ready', prompt: 'Ready car', status: 'completed', seen: false, updated_at: '2026-10-18', is_edit: false },
    { id: 'seen', prompt: 'Already viewed', status: 'completed', seen: true, updated_at: '2026-10-17', is_edit: false },
  ];
  vi.mocked(GetUserGenerationsApiService.getUserGenerations).mockResolvedValue({
    generations: [historyBuild('ready', 'Ready car'), historyBuild('seen', 'Already viewed', '2026-10-17')],
    total_count: 2, total_user_generations: 2, all_orders: [], has_more: false,
  });
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockImplementation(async id => generation(id));
  await act(async () => root.render(<LandingPage />));
  act(() => container.querySelector<HTMLButtonElement>('header .landing-create-new')!.click());
  expect(container.querySelector('.pet-dialogue')?.textContent).toContain('What would you like to do?');
  expect(input()).not.toBeNull();
  act(() => Array.from(container.querySelectorAll<HTMLButtonElement>('.pet-dialogue button')).find(button => button.textContent === 'Show builds')!.click());
  const rows = [...container.querySelectorAll('[aria-label="Your current builds"] li')];
  expect(rows).toHaveLength(3);
  expect(rows[0].textContent).toContain('Rocket');
  expect(rows[1].textContent).toContain('Ready car');
  expect(rows[1].textContent).toContain('View model');
  expect(rows[2].textContent).toContain('Already viewed');
  await act(async () => rows[1].querySelector('a')!.click());
  expect(query.value).toContain('id=ready');
});

it('pages recent builds in the pet dialogue and offers more after the first five', async () => {
  const builds = Array.from({ length: 7 }, (_, index) => historyBuild(`build-${index}`, `Build ${index}`, `2026-10-${String(19 - index).padStart(2, '0')}`));
  vi.mocked(GetUserGenerationsApiService.getUserGenerations).mockResolvedValue({
    generations: builds, total_count: 7, total_user_generations: 7, all_orders: [], has_more: false,
  });
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('.pet-dialogue')?.textContent).toContain('What would you like to do?');
  act(() => Array.from(container.querySelectorAll<HTMLButtonElement>('.pet-dialogue button')).find(button => button.textContent === 'Show builds')!.click());
  let rows = [...container.querySelectorAll('[aria-label="Your current builds"] li')];
  expect(rows).toHaveLength(5);
  expect(rows[0].textContent).toContain('Build 0');
  expect(container.querySelector('.pet-dialogue')?.textContent).toContain('Want to view more?');
  act(() => Array.from(container.querySelectorAll<HTMLButtonElement>('.pet-dialogue button')).find(button => button.textContent === 'Yes, show more')!.click());
  rows = [...container.querySelectorAll('[aria-label="Your current builds"] li')];
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain('Build 5');
  expect(container.querySelector('.pet-dialogue')?.textContent).not.toContain('Want to view more?');
  expect(posthog.capture).toHaveBeenCalledWith('landing_recent_builds_more_clicked', { page: 1, completed_count: 7 });
});

it('suggests random builds before starting one and offers a new idea or a way back', async () => {
  const generate = vi.spyOn(NovaToBricksApiService, 'generate').mockResolvedValue({ generation_id: 'random', message: 'Started' });
  const suggest = vi.spyOn(BuildBuddyApi, 'randomIdea')
    .mockResolvedValueOnce('a Pikachu riding a skateboard')
    .mockResolvedValueOnce('the Millennium Falcon')
    .mockResolvedValueOnce('a tiny Hogwarts greenhouse');
  await act(async () => root.render(<LandingPage />));
  const actions = [...container.querySelectorAll<HTMLButtonElement>('.pet-greeting .pet-chat-action')];
  expect(actions.map(button => button.textContent)).toEqual(['Build something random', 'Show builds', 'Show me community models']);
  act(() => actions[2].click());
  expect(navigate).toHaveBeenCalledWith('/community');
  await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>('.pet-greeting .pet-chat-action')).find(button => button.textContent === 'Build something random')!.click());
  const firstIdea = container.querySelector('.pet-dialogue p')?.textContent;
  expect(firstIdea).toBe('How about a Pikachu riding a skateboard?');
  expect(suggest).toHaveBeenCalledWith([], undefined, expect.any(AbortSignal));
  expect(generate).not.toHaveBeenCalled();
  expect(container.querySelector('#landing-build-prompt')).toBeNull();
  await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>('.pet-dialogue button')).find(button => button.textContent === 'No')!.click());
  expect(container.querySelector('.pet-dialogue p')?.textContent).toBe('How about the Millennium Falcon?');
  expect(suggest).toHaveBeenLastCalledWith(['a Pikachu riding a skateboard'], undefined, expect.any(AbortSignal));
  act(() => Array.from(container.querySelectorAll<HTMLButtonElement>('.pet-dialogue button')).find(button => button.textContent === 'Go back')!.click());
  expect(container.querySelector('.pet-greeting')).not.toBeNull();
  await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>('.pet-greeting .pet-chat-action')).find(button => button.textContent === 'Build something random')!.click());
  await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>('.pet-dialogue button')).find(button => button.textContent === 'Yes')!.click());
  expect(generate).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'a tiny Hogwarts greenhouse' }), undefined);
  expect(posthog.capture).toHaveBeenCalledWith('landing_community_models_clicked', { surface: 'pet_dialogue' });
});

it('shows loading and retry states without using an old or failed random suggestion', async () => {
  let resolve!: (idea: string) => void;
  const suggest = vi.spyOn(BuildBuddyApi, 'randomIdea')
    .mockImplementationOnce(() => new Promise(done => { resolve = done; }))
    .mockRejectedValueOnce(new Error('private upstream response'))
    .mockResolvedValueOnce('a dancing R2-D2');
  await act(async () => root.render(<LandingPage />));
  act(() => Array.from(container.querySelectorAll<HTMLButtonElement>('.pet-dialogue button')).find(button => button.textContent === 'Build something random')!.click());
  expect(container.querySelector('.pet-dialogue [role="status"][aria-label="Build buddy is typing"]')?.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(3);
  expect(container.querySelector('.pet-dialogue')?.textContent).not.toContain('I’m thinking of something fun to build');
  expect(container.querySelector('.pet-dialogue')?.textContent).not.toContain('Yes');
  const firstSignal = suggest.mock.calls[0][2];
  act(() => Array.from(container.querySelectorAll<HTMLButtonElement>('.pet-dialogue button')).find(button => button.textContent === 'Go back')!.click());
  expect(firstSignal.aborted).toBe(true);
  await act(async () => resolve('a stale dragon'));
  expect(container.querySelector('.pet-dialogue')?.textContent).not.toContain('stale dragon');
  await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>('.pet-dialogue button')).find(button => button.textContent === 'Build something random')!.click());
  expect(container.querySelector('.pet-dialogue')?.textContent).toContain('Want me to try again?');
  expect(container.querySelector('.pet-dialogue')?.textContent).not.toContain('private upstream');
  await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>('.pet-dialogue button')).find(button => button.textContent === 'Try again')!.click());
  expect(container.querySelector('.pet-dialogue')?.textContent).toContain('How about a dancing R2-D2?');
  expect(container.querySelector('.pet-dialogue [aria-label="Build buddy is typing"]')).toBeNull();
  expect(suggest).toHaveBeenCalledTimes(3);
});

it('shows an empty build list only when requested and returns to the opening question', async () => {
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('.pet-dialogue')?.textContent).toContain('What would you like to do?');
  expect(container.querySelector('.pet-dialogue')?.textContent).not.toContain('0 builds');
  act(() => Array.from(container.querySelectorAll<HTMLButtonElement>('.pet-dialogue button')).find(button => button.textContent === 'Show builds')!.click());
  expect(container.querySelector('.pet-dialogue')?.textContent).toContain('You don’t have any builds yet.');
  expect(container.querySelector('[aria-label="Your current builds"]')).toBeNull();
  expect(container.querySelector('#landing-build-prompt')).toBeNull();
  act(() => Array.from(container.querySelectorAll<HTMLButtonElement>('.pet-dialogue button')).find(button => button.textContent === 'Go back')!.click());
  expect(container.querySelector('.pet-dialogue')?.textContent).toContain('What would you like to do?');
  expect(input()).not.toBeNull();
  expect(posthog.capture).toHaveBeenCalledWith('landing_builds_opened', { surface: 'pet_dialogue', processing_count: 0, completed_count: 0 });
});

it('keeps the opening question independent of build counts', async () => {
  vi.setSystemTime(new Date('2026-10-19T18:01:00Z'));
  activity.rows = [{ id: 'working', status: 'processing', endpoint: 'novaToBricks', prompt: 'Rocket', createdAt: '2026-10-19T18:00:00Z' }];
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('.pet-dialogue')?.textContent).toContain('What would you like to do?');
  expect(container.querySelector('.pet-dialogue')?.textContent).not.toContain('Rocket');
  expect(container.querySelector('.pet-dialogue')?.textContent).toContain('Building for 1m 0s');
  act(() => root.render(null));
  activity.rows = [];
  vi.mocked(GetUserGenerationsApiService.getUserGenerations).mockResolvedValue({
    generations: [historyBuild('ready', 'Ready castle')], total_count: 1, total_user_generations: 1, all_orders: [], has_more: false,
  });
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('.pet-dialogue')?.textContent).toContain('What would you like to do?');
  expect(container.querySelector('.pet-dialogue')?.textContent).not.toContain('Ready castle');
});

it('keeps the opening question and composer if the last processing build clears', async () => {
  activity.rows = [{ id: 'working', status: 'processing', endpoint: 'novaToBricks', prompt: 'Rocket' }];
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('.pet-dialogue')?.textContent).toContain('What would you like to do?');
  expect(input()).not.toBeNull();
  activity.rows = [];
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('.pet-dialogue')?.textContent).toContain('What would you like to do?');
  expect(container.querySelector('.pet-dialogue')?.textContent).not.toContain('0 builds');
  expect(input()).not.toBeNull();
});

it.each(['llmToBricks', 'novaToBricks', 'textTo3d'])('shows only a 3D assembly in the %s viewer slot while generating', async endpoint => {
  query.value = 'id=building&exact=1';
  activity.rows = [{ id: 'building', status: 'processing', endpoint, prompt: 'A cat', createdAt: new Date().toISOString() }];
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue({ ...generation('building', endpoint), status: 'processing' });
  const cancel = vi.spyOn(GetGenerationApiService, 'cancelGeneration').mockResolvedValue(undefined);
  await act(async () => root.render(<LandingPage />));
  const conversation = container.querySelector('[aria-label="Build buddy conversation"]')!;
  const workspace = container.querySelector('[aria-label="Build progress workspace"]')!;
  expect(workspace.querySelector('[aria-label="3D brick model assembling"]')).not.toBeNull();
  expect(workspace.querySelector('[data-testid="generation-3d-animation"]')?.getAttribute('data-scene')).toMatch(/\.mpd$/);
  expect(workspace.querySelector('article')).toBeNull();
  expect(container.querySelector('[aria-label="Your generations"]')).toBeNull();
  expect(workspace.compareDocumentPosition(conversation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(container.querySelector('#landing-build-prompt')).toBeNull();
  const actions = container.querySelector('[aria-label="Generation in progress actions"]')!;
  expect(conversation.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(actions.textContent).toContain('This can take up to 30 minutes. Do you want an email when it’s ready?');
  expect(container.querySelector('button[type="submit"][aria-label="Create"]')).toBeNull();
  await act(async () => Array.from(actions.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Cancel')!.click());
  expect(cancel).toHaveBeenCalledExactlyOnceWith('building');
  expect(activity.track).toHaveBeenCalledWith(expect.objectContaining({ id: 'building', status: 'cancelled' }));
});

it('hides the order banner while editing and restores it after focus leaves the composer', async () => {
  query.value = 'id=castle&exact=1';
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue(generation('castle'));
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('[aria-label="Order your brick kit"]')).not.toBeNull();
  act(() => input().focus());
  expect(container.querySelector('[aria-label="Order your brick kit"]')).toBeNull();
  expect(container.querySelector('[data-testid="viewer"]')).not.toBeNull();
  act(() => input().blur());
  expect(container.querySelector('[aria-label="Order your brick kit"]')).not.toBeNull();
});

it('submits a focused model edit on the first touch before the order banner returns', async () => {
  query.value = 'id=castle&exact=1';
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockImplementation(async id => ({ ...generation(id), status: id === 'edited' ? 'processing' : 'completed' }));
  const edit = vi.spyOn(NovaToBricksApiService, 'edit').mockResolvedValue({ generation_id: 'edited', message: 'Started' });
  await act(async () => root.render(<LandingPage />));
  act(() => input().focus());
  type('Add a drawbridge');
  expect(container.querySelector('[aria-label="Order your brick kit"]')).toBeNull();
  const send = container.querySelector<HTMLButtonElement>('button[aria-label="Apply edit"]')!;
  const touch = new Event('pointerdown', { bubbles: true, cancelable: true });
  Object.defineProperty(touch, 'pointerType', { value: 'touch' });
  await act(async () => {
    send.dispatchEvent(touch);
    input().blur();
    send.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  });
  expect(touch.defaultPrevented).toBe(true);
  expect(edit).toHaveBeenCalledExactlyOnceWith('castle', 'Add a drawbridge', undefined);
  expect(container.querySelector('[aria-label="Building your edited model"]')).not.toBeNull();
});

it('restores the order banner when a returning phone app has closed its keyboard', async () => {
  query.value = 'id=castle&exact=1';
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue(generation('castle'));
  vi.stubGlobal('innerHeight', 844);
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
  vi.stubGlobal('visualViewport', viewport);
  await act(async () => root.render(<LandingPage />));
  act(() => input().focus());
  expect(container.querySelector('[aria-label="Order your brick kit"]')).toBeNull();
  viewport.height = 450;
  act(() => viewport.dispatchEvent(new Event('resize')));
  viewport.height = 844;
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(container.querySelector('[aria-label="Order your brick kit"]')).not.toBeNull();
  expect(document.activeElement).not.toBe(input());
});

it('replaces loading messages with one animated model greeting when a linked build is ready', async () => {
  query.value = 'id=castle&exact=1';
  localStorage.setItem('brickbuilder.build-buddy-seen', 'true');
  inbox.notifications = [{ id: 'other', prompt: 'Other model', status: 'completed', seen: false, updated_at: '2026-10-17', is_edit: false }];
  activity.rows = [{ id: 'castle', status: 'processing', endpoint: 'novaToBricks', prompt: 'A castle' }];
  let ready = false;
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockImplementation(async () => ({ ...generation('castle'), status: ready ? 'completed' : 'processing' }));
  await act(async () => root.render(<LandingPage />));
  const dialogue = container.querySelector('[aria-label="Build buddy conversation"]')!;
  expect(dialogue.textContent).not.toContain('Welcome back');
  expect(dialogue.textContent).not.toContain('Want to see');
  ready = true;
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(container.querySelector('[data-testid="viewer"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Build buddy conversation"]')).toBe(dialogue);
  expect(dialogue.querySelectorAll('.pet-greeting')).toHaveLength(1);
  expect(dialogue.querySelector('.pet-response-word')).not.toBeNull();
  expect(dialogue.querySelector('.pet-chat-message')).toBeNull();
  expect(dialogue.textContent).toContain('order button');
  expect(dialogue.textContent).toContain('delivered');
  expect(dialogue.textContent).not.toContain('Welcome back');
  expect(dialogue.textContent).not.toContain('Want to see');
  expect(dialogue.querySelector('button')).toBeNull();
  expect(container.querySelector('[aria-label="Your generations"]')).toBeNull();
  expect(input().getAttribute('aria-label')).toBe('Describe changes to your model');
});

it('orders the ready landing model using its displayed quote and dismisses only the mobile banner', async () => {
  query.value = 'id=castle&exact=1';
  activity.rows = [{ id: 'castle', status: 'completed', endpoint: 'novaToBricks', prompt: 'Castle' }];
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue(generation('castle'));
  await act(async () => root.render(<LandingPage />));
  const dialogue = container.querySelector('[aria-label="Build buddy conversation"]');
  const banner = container.querySelector('[aria-label="Order your brick kit"]')!;
  expect(banner.textContent).toContain('$22.39');
  await act(async () => banner.querySelector<HTMLButtonElement>('[aria-label="Order this model"]')!.click());
  expect(navigate).toHaveBeenCalledWith('/order', { state: expect.objectContaining({
    generation_id: 'castle', name: 'Castle', priceData: expect.objectContaining({ total_price: 44.77 }),
  }) });
  act(() => banner.querySelector<HTMLButtonElement>('[aria-label="Dismiss order banner"]')!.click());
  expect(container.querySelector('[aria-label="Order your brick kit"]')).toBeNull();
  expect(container.querySelector('[aria-label="Build buddy conversation"]')).toBe(dialogue);
  expect(posthog.capture).toHaveBeenCalledWith('landing_model_order_banner_dismissed', { generation_id: 'castle' });
});

it('keeps the header free of order buttons and shows piece count in the order bar', async () => {
  query.value = 'id=castle&exact=1';
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue(generation('castle'));
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('.landing-model-heading')).toBeNull();
  expect(container.querySelector('.model-order-dialog')).toBeNull();
  const banner = container.querySelector('.model-mobile-order')!;
  expect(banner.classList.contains('model-mobile-order--all-screens')).toBe(true);
  expect(banner.textContent).toContain('370 pieces');
  expect(banner.textContent).not.toContain('Shipping included');
  expect(banner.querySelector('strong')?.textContent).toBe('$22.39');
});

it('keeps a dismissed banner closed for the current model and shows it for the next completed model', async () => {
  const renderModel = (id: string, busy = false) => act(async () => root.render(<LandingModelWorkspace
    model={{ generation: generation(id), content: 'model' }} busy={busy}
   ><div>Conversation</div></LandingModelWorkspace>));
  await renderModel('first');
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Dismiss order banner"]')!.click());
  await renderModel('first', true);
  await renderModel('first');
  expect(container.querySelector('.model-mobile-order')).toBeNull();
  await renderModel('second');
  expect(container.querySelector('.model-mobile-order')).not.toBeNull();
  expect(GetPriceApiService.getPrice).toHaveBeenLastCalledWith('second', undefined);
});

it('never applies a late quote to a different displayed model', async () => {
  let finish!: (quote: Awaited<ReturnType<typeof GetPriceApiService.getPrice>>) => void;
  vi.mocked(GetPriceApiService.getPrice).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue({ generation_id: 'second', total_price: 20, total_weight: 0, total_parts: 10, parts_breakdown: [] } as never);
  const renderModel = (id: string) => act(async () => root.render(<LandingModelWorkspace
    model={{ generation: generation(id), content: 'model' }} busy={false}
   ><div>Conversation</div></LandingModelWorkspace>));
  await renderModel('first');
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Order this model"]')!.disabled).toBe(true);
  await renderModel('second');
  await act(async () => finish({ generation_id: 'first', total_price: 100, total_weight: 0, total_parts: 100, parts_breakdown: [] } as never));
  expect(container.querySelector('.model-mobile-order strong')?.textContent).toBe('$10.00');
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Order this model"]')!.click());
  expect(navigate).toHaveBeenCalledWith('/order', { state: expect.objectContaining({
    generation_id: 'second', priceData: expect.objectContaining({ total_price: 20 }),
  }) });
});

it('keeps a failed landing quote unorderable while allowing the banner to be dismissed', async () => {
  vi.mocked(GetPriceApiService.getPrice).mockRejectedValue(new Error('Pricing unavailable'));
  query.value = 'id=castle&exact=1';
  activity.rows = [{ id: 'castle', status: 'completed', endpoint: 'novaToBricks', prompt: 'Castle' }];
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue(generation('castle'));
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Order this model"]')!.disabled).toBe(true);
  expect(container.querySelector('.model-mobile-order')?.textContent).toContain('Price unavailable right now');
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Dismiss order banner"]')!.click());
  expect(container.querySelector('.model-mobile-order')).toBeNull();
  expect(navigate).not.toHaveBeenCalled();
});

it.each([{ orderable: false }, { endpoint: 'uploadLdraw' }])('keeps ordering unavailable for imported or unapproved models: %o', async patch => {
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue({ ...generation('castle'), ...patch });
  query.value = 'id=castle&exact=1';
  activity.rows = [{ id: 'castle', status: 'completed', endpoint: patch.endpoint || 'novaToBricks', prompt: 'Castle' }];
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('.model-mobile-order')).toBeNull();
  expect(container.querySelector('.landing-model-order-trigger')).toBeNull();
  expect(container.textContent).not.toContain('order button');
  expect(GetPriceApiService.getPrice).not.toHaveBeenCalled();
});

it('keeps the LDraw upload page intro visible when a previous chat workspace is saved', async () => {
  sessionStorage.setItem('brickbuilder.landing-model:guest', 'castle');
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue(generation('castle'));
  await act(async () => root.render(<LandingPage imageLandingPath="use-ai-to-edit-ldraw" />));
  expect(container.querySelector('.landing-page-intro')).toBeNull();
  expect(container.querySelector('[aria-label="Choose LDraw file"]')).not.toBeNull();
  expect(container.querySelector('.landing-page')).toBeNull();
});

it.each(['novaToBricks', 'llmToBricks', 'uploadLdraw'])('edits %s with animation and restores the new viewer when ready', async endpoint => {
  query.value = 'id=castle&exact=1';
  activity.rows = [{ id: 'castle', status: 'completed', endpoint, prompt: 'Castle' }];
  let ready = false;
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockImplementation(async id => id === 'castle'
    ? generation(id, endpoint) : { ...generation(id, endpoint), name: 'Castle with bridge', status: ready ? 'completed' : 'processing', example_edit_prompt: 'Add flags' });
  const nova = vi.spyOn(NovaToBricksApiService, 'edit').mockResolvedValue({ generation_id: 'edited', message: 'Started' });
  const llm = vi.spyOn(LlmToBricksApiService, 'generate').mockResolvedValue({ generation_id: 'edited', message: 'Started' });
  await act(async () => root.render(<LandingPage />));
  type('Add a drawbridge');
  expect(container.querySelector('.landing-page--conversation-started')).not.toBeNull();
  await submit();
  if (endpoint === 'llmToBricks') {
    expect(llm).toHaveBeenCalledExactlyOnceWith({ sourceGenerationId: 'castle', prompt: 'Add a drawbridge' }, undefined);
    expect(nova).not.toHaveBeenCalled();
  } else {
    expect(nova).toHaveBeenCalledExactlyOnceWith('castle', 'Add a drawbridge', undefined);
    expect(llm).not.toHaveBeenCalled();
  }
  expect(container.querySelector('[data-testid="viewer"]')).toBeNull();
  expect(container.querySelector('[aria-label="Building your edited model"] [data-testid="generation-3d-animation"]')).not.toBeNull();
  expect(container.querySelector('#landing-build-prompt')).toBeNull();
  const editActions = container.querySelector('[aria-label="Generation in progress actions"]')!;
  expect(editActions.textContent).toContain('Email me');
  expect(container.querySelector('[aria-label="Generation in progress actions"]')?.textContent).toContain('Cancel');
  expect(container.querySelector('[aria-label="Generation in progress actions"]')?.textContent).toContain('Start new');
  expect(container.querySelector('.landing-model-toolbar')).toBeNull();
  expect(container.querySelector('.model-mobile-order')).toBeNull();
  expect(container.querySelector('.pet-dialogue')?.textContent).not.toContain('email');
  expect(container.querySelector('.pet-dialogue')?.textContent).not.toContain('Your generations');
  expect(container.textContent).not.toContain('Updating your model');
  expect(container.querySelector<HTMLButtonElement>('.landing-create-new')!.disabled).toBe(false);
  ready = true;
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(container.querySelector('[data-testid="viewer"]')).not.toBeNull();
  expect(input().disabled).toBe(false);
  expect(container.querySelector('[aria-label="Model suggestions"]')).toBeNull();
  expect(container.querySelector('[data-testid="viewer"]')?.getAttribute('data-model-name')).toBe('Castle with bridge');
});

it.each(['Cancel', 'Start new'])('%s leaves an in-progress edit without keeping its animation on screen', async action => {
  query.value = 'id=castle&exact=1';
  activity.rows = [{ id: 'castle', status: 'completed', endpoint: 'novaToBricks', prompt: 'Castle' }];
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockImplementation(async id => ({ ...generation(id), status: id === 'edited' ? 'processing' : 'completed' }));
  vi.spyOn(NovaToBricksApiService, 'edit').mockResolvedValue({ generation_id: 'edited', message: 'Started' });
  const cancel = vi.spyOn(GetGenerationApiService, 'cancelGeneration').mockResolvedValue(undefined);
  await act(async () => root.render(<LandingPage />));
  type('Add a drawbridge');
  await submit();
  expect(container.querySelector('[aria-label="Building your edited model"] [data-testid="generation-3d-animation"]')).not.toBeNull();
  const actionButton = Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="Generation in progress actions"] button'))
    .find(button => button.textContent === action)!;
  await act(async () => actionButton.click());
  expect(container.querySelector('[aria-label="Building your edited model"]')).toBeNull();
  if (action === 'Cancel') {
    expect(cancel).toHaveBeenCalledExactlyOnceWith('edited');
    expect(container.querySelector('[data-testid="viewer"]')).not.toBeNull();
    expect(input().getAttribute('aria-label')).toBe('Describe changes to your model');
    expect(query.value).toContain('id=castle');
  } else {
    expect(cancel).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="viewer"]')).toBeNull();
    expect(container.querySelector('.pet-dialogue')?.textContent).toContain('What would you like to do?');
    expect(input().getAttribute('aria-label')).toBe('Describe your model');
    expect(query.value).not.toContain('id=');
  }
});

it('keeps the current model and edit text available after an edit request fails', async () => {
  query.value = 'id=castle&exact=1';
  activity.rows = [{ id: 'castle', status: 'completed', prompt: 'Castle' }];
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue(generation('castle'));
  vi.spyOn(NovaToBricksApiService, 'edit').mockRejectedValue(new Error('Please try again'));
  await act(async () => root.render(<LandingPage />));
  type('Add a bridge'); await submit();
  expect(container.querySelector('[data-testid="viewer"]')).not.toBeNull();
  expect(input().value).toBe('Add a bridge');
  expect(input().disabled).toBe(false);
  expect(buddy.updateTurn).toHaveBeenCalledWith(1, {
    error: 'Oops! I couldn’t make your build. Please try again.', reply: undefined,
  });
  expect(container.textContent).not.toContain('Please try again');
  expect(container.textContent).not.toContain('Generation Failed');
});

it('falls back to LDR conversion and ignores a late model response after reset', async () => {
  let model!: ReturnType<typeof useLandingModel>;
  function Probe() { model = useLandingModel('guest'); return null; }
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue({ ...generation('castle'), mpd_url: null });
  const convert = vi.spyOn(LdrToMpdApiService, 'convertLdrToMpd').mockResolvedValue({ mpd_content: 'converted', message: 'Converted' });
  await act(async () => root.render(<Probe />));
  await act(async () => model.open('castle'));
  expect(convert).toHaveBeenCalledWith('castle ldr', 'Castle', undefined);
  expect(model.model?.content).toBe('converted');
  await act(async () => model.open('castle'));
  expect(model.model?.content).toBe('converted');
  expect(model.busy).toBe(false);
  let finish!: (value: GetGenerationResponse) => void;
  vi.mocked(GetGenerationApiService.getGeneration).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => model.open('late'));
  act(() => model.reset());
  await act(async () => finish(generation('late')));
  expect(model.model).toBeNull();
  expect(model.busy).toBe(false);
});

it('ignores saved workspaces on plain visits and clears the displayed model when accounts change', async () => {
  let model!: ReturnType<typeof useLandingModel>;
  function Probe({ owner }: { owner: string }) { model = useLandingModel(owner); return null; }
  sessionStorage.setItem('brickbuilder.landing-model:builder', 'castle');
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue(generation('castle'));
  await act(async () => root.render(<Probe owner="builder" />));
  expect(model.model).toBeNull();
  await act(async () => model.open('castle'));
  expect(model.model?.generation.generation_id).toBe('castle');
  await act(async () => root.render(<Probe owner="someone-else" />));
  expect(model.model).toBeNull();
  expect(model.targetId).toBeNull();
  await act(async () => root.render(<Probe owner="builder" />));
  expect(model.model).toBeNull();
  act(() => model.reset());
  expect(sessionStorage.getItem('brickbuilder.landing-model:builder')).toBeNull();
});

it('shows build anything with a cursor on model links without cycling suggestions', async () => {
  query.value = 'id=castle&exact=1';
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue(generation('castle'));
  await act(async () => root.render(<LandingPage />));
  expect(input().placeholder).toBe('');
  expect(container.querySelector('.landing-empty-input-hint--edit')?.textContent).toBe('build anything');
  type('Add a flag'); type('');
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(input().placeholder).toBe('');
  expect(container.querySelector('.landing-empty-input-hint--edit')?.textContent).toBe('build anything');
  expect(container.querySelector('[aria-label="Model suggestions"]')).toBeNull();
});

it('uses the saved edit suggestion or falls back to a color edit', () => {
  const model: LandingModel = { generation: { ...generation('castle'), example_edit_prompt: null }, content: 'mpd' };
  expect(modelEditSuggestion(model)).toBe('Change the colors of the Castle');
  model.generation.example_edit_prompt = 'Add more detail to the Castle';
  expect(modelEditSuggestion(model)).toBe('Add more detail to the Castle');
});

it('keeps landing-model initialization safe for public-page prerendering', () => {
  const browserWindow = window;
  function ServerProbe() { const model = useLandingModel('guest'); return <span>{model.targetId || 'New build'}</span>; }
  try {
    vi.stubGlobal('window', undefined);
    expect(renderToStaticMarkup(<ServerProbe />)).toBe('<span>New build</span>');
  } finally { vi.stubGlobal('window', browserWindow); }
});

it('opens an email-linked generation ahead of the saved model and other active builds, and clears the link on create new', async () => {
  query.value = 'id=email-build&exact=1&utm_source=email';
  sessionStorage.setItem('brickbuilder.landing-model:guest', 'saved-castle');
  activity.rows = [{ id: 'another-build', status: 'processing', prompt: 'Car', endpoint: 'novaToBricks' }];
  const load = vi.spyOn(GetGenerationApiService, 'getGeneration').mockImplementation(async id => generation(id));
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('[data-testid="viewer"]')).not.toBeNull();
  expect(load.mock.calls.map(call => call[0])).toEqual(['email-build']);
  expect(sessionStorage.getItem('brickbuilder.landing-model:guest')).toBe('email-build');
  expect(viewer.markViewed).not.toHaveBeenCalled();
  await act(async () => viewer.loaded!());
  expect(viewer.markViewed).toHaveBeenCalledWith('email-build');
  act(() => container.querySelector<HTMLButtonElement>('.landing-create-new')!.click());
  expect(query.value).toBe('utm_source=email');
  expect(container.querySelector('[data-testid="viewer"]')).toBeNull();
});

it('waits for a rendered model before acknowledging notifications and retries a failed receipt', async () => {
  viewer.markViewed.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  const model = { generation: generation('castle'), content: 'castle mpd' };
  await act(async () => root.render(<LandingModelWorkspace model={model} busy={false}>{null}</LandingModelWorkspace>));
  expect(viewer.markViewed).not.toHaveBeenCalled();
  await act(async () => viewer.loaded!());
  expect(viewer.markViewed).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(viewer.markViewed).toHaveBeenCalledTimes(2);
  await act(async () => root.render(<LandingModelWorkspace model={{ generation: generation('second'), content: 'second mpd' }} busy={false}>{null}</LandingModelWorkspace>));
  expect(viewer.markViewed).toHaveBeenCalledTimes(2);
});

it.each(['failed', 'cancelled'] as const)('preserves the previous model and allows retrying after a %s edit', async status => {
  let model!: ReturnType<typeof useLandingModel>;
  function Probe() { model = useLandingModel('guest'); return null; }
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValueOnce(generation('castle'))
    .mockResolvedValueOnce({ ...generation('edited'), status });
  await act(async () => root.render(<Probe />));
  await act(async () => model.open('castle'));
  await act(async () => model.open('edited', true));
  expect(model.model?.generation.generation_id).toBe('castle');
  expect(model.busy).toBe(false);
  expect(model.error).toBeTruthy();
});


it('keeps Create new centered in the header for guests alongside sign up, tools and notifications', async () => {
  auth.isSupabaseConfigured = true;
  query.value = 'id=castle&exact=1';
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue(generation('castle'));
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('header.landing-header--guest-model')).not.toBeNull();
  expect(container.querySelector('header .landing-create-new')?.textContent).toBe('Create new');
  expect(container.querySelector('header nav')?.textContent).toContain('Sign up');
});


it('passes the displayed model name into the greeting and replaces it with a preview-specific compliment', async () => {
  query.value = 'id=castle&exact=1';
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue(generation('castle'));
  vi.spyOn(BuildBuddyApi, 'modelGreeting').mockResolvedValue('Castle’s red flags look great above those tall walls!');
  await act(async () => root.render(<LandingPage />));
  const conversation = container.querySelector('.pet-dialogue')!;
  expect(conversation.textContent).toContain('Castle’s red flags');
  expect(Array.from(conversation.querySelectorAll('strong')).map(el => el.textContent)).toEqual(['edit', 'order']);
  expect(conversation.querySelectorAll('.pet-greeting')).toHaveLength(1);
});


it('replaces the old model with only the build animation during an edit', async () => {
  const render = (model: LandingModel | null, pendingEdit: boolean) => act(async () => root.render(
    <LandingModelWorkspace model={model} busy={pendingEdit} pendingEdit={pendingEdit}><p>Conversation</p></LandingModelWorkspace>));
  await render(null, false);
  await render(null, true);
  expect(container.querySelector('[data-testid="generation-3d-animation"]')).toBeNull();
  await render({ generation: generation('castle'), content: 'castle mpd' }, true);
  expect(container.querySelectorAll('[data-testid="generation-3d-animation"]')).toHaveLength(1);
  expect(container.querySelector('[data-testid="viewer"]')).toBeNull();
  expect(container.querySelector('.landing-model-toolbar')).toBeNull();
  expect(container.querySelector('.model-mobile-order')).toBeNull();
});

it.each(['failed', 'cancelled'] as const)('removes the centered loading state after a linked build is %s', async status => {
  query.value = 'id=castle&exact=1';
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue({ ...generation('castle'), status });
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('.landing-model-loading')).toBeNull();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
});


it('opens an emailed instructions link in a dialog after the model loads and lets the buyer return', async () => {
  query.value = 'id=castle&exact=1&instructions=1';
  let finish!: (value: GetGenerationResponse) => void;
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('[aria-modal="true"]')).toBeNull();
  await act(async () => finish(generation('castle')));
  const dialog = container.querySelector<HTMLDialogElement>('.landing-model-panel')!;
  expect(dialog.getAttribute('aria-label')).toBe('Expanded instructions');
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(dialog.showModal).toHaveBeenCalled();
  expect(container.textContent).toContain('Building instructions');
  expect(document.body.style.overflow).toBe('hidden');
  expect(posthog.capture).toHaveBeenCalledWith('landing_model_view_expanded', { generation_id: 'castle', view: 'instructions', source: 'url' });
  await act(async () => container.querySelector<HTMLButtonElement>('.landing-view-back')!.click());
  await act(async () => root.render(<LandingPage />));
  expect(dialog.dataset.expanded).toBe('false');
  expect(document.body.style.overflow).toBe('');
  await act(async () => container.querySelector<HTMLButtonElement>('.landing-instructions-toggle')!.click());
  expect(container.querySelector('[data-testid="viewer"]')).not.toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('.landing-create-new')!.click());
  expect(query.value).toBe('');
});

it('responds to instructions URL navigation for the same model and resets for another model', async () => {
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockImplementation(async id => generation(id));
  query.value = 'id=castle&instructions=0';
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('.landing-model-panel')?.getAttribute('data-view')).toBe('model');
  query.value = 'id=castle&instructions=1';
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('.landing-model-panel')?.getAttribute('aria-modal')).toBe('true');
  query.value = 'id=rover';
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('.landing-model-panel')?.getAttribute('data-view')).toBe('model');
  expect(container.querySelector('.landing-model-panel')?.getAttribute('aria-modal')).toBeNull();
  expect(document.body.style.overflow).toBe('');
});

it('does not open instructions without an explicit model ID', async () => {
  query.value = 'instructions=1';
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('.landing-model-panel')).toBeNull();
});

it('places a book button below the model, matches Create new, and switches views without navigating', async () => {
  query.value = 'id=castle&exact=1';
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue(generation('castle'));
  await act(async () => root.render(<LandingPage />));
  const frame = container.querySelector('.landing-model-workspace')!;
  const button = container.querySelector<HTMLButtonElement>('.landing-instructions-toggle')!;
  const conversation = container.querySelector('.landing-model-conversation');
  expect(button.textContent).toBe('Show instructions');
  expect(button.querySelector('.lucide-book-open')).not.toBeNull();
  expect(button.classList.contains('landing-action-button')).toBe(true);
  expect(container.querySelector('.landing-create-new')?.classList.contains('landing-action-button')).toBe(true);
  expect(frame.contains(button)).toBe(false);
  expect(frame.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(button.closest('.landing-model-conversation')).toBeNull();
  await act(async () => button.click());
  expect(container.querySelector('[aria-label="Instructions viewer"]')).not.toBeNull();
  expect(container.textContent).toContain('Building instructions');
  expect(button.textContent).toBe('Show model');
  expect(button.getAttribute('aria-pressed')).toBe('true');
  expect(document.getElementById(button.getAttribute('aria-controls')!)).not.toBeNull();
  expect(container.querySelector('.landing-model-conversation')).toBe(conversation);
  expect(query.value).toBe('id=castle&exact=1');
  expect(navigate).not.toHaveBeenCalled();
  expect(posthog.capture).toHaveBeenCalledWith('landing_model_instructions_clicked', { generation_id: 'castle', source: 'viewer_footer' });
  await act(async () => button.click());
  expect(container.querySelector('[data-testid="viewer"]')).not.toBeNull();
  expect(button.getAttribute('aria-pressed')).toBe('false');
  expect(posthog.capture).toHaveBeenCalledWith('landing_model_3d_view_clicked', { generation_id: 'castle', source: 'viewer_footer' });
});

it('blocks scroll gestures on the model and instruction canvas, while allowing chat and parts scrolling', async () => {
  await act(async () => root.render(<LandingModelWorkspace model={{ generation: generation('castle'), content: 'model' }} busy={false}>
    <div className="test-chat">Conversation</div></LandingModelWorkspace>));
  const stage = container.querySelector('.landing-model-stage')!;
  const scrollGesture = (target: Element, type: string) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    act(() => target.dispatchEvent(event));
    return event.defaultPrevented;
  };
  for (const type of ['wheel', 'touchmove']) {
    expect(scrollGesture(stage, type)).toBe(true);
    expect(scrollGesture(container.querySelector('.test-chat')!, type)).toBe(false);
  }
  await act(async () => container.querySelector<HTMLButtonElement>('.landing-instructions-toggle')!.click());
  for (const type of ['wheel', 'touchmove']) {
    expect(scrollGesture(stage.querySelector('canvas')!, type)).toBe(true);
    expect(scrollGesture(stage.querySelector('.instructions-parts')!, type)).toBe(false);
  }
  const remove = vi.spyOn(stage, 'removeEventListener');
  act(() => root.render(null));
  expect(remove).toHaveBeenCalledWith('touchmove', expect.any(Function));
  expect(remove).toHaveBeenCalledWith('wheel', expect.any(Function));
});

it('disables instruction toggling while editing and resets to the model when the selected build changes', async () => {
  const render = (id: string, busy = false) => act(async () => root.render(<LandingModelWorkspace
    model={{ generation: generation(id), content: id }} busy={busy}>{null}</LandingModelWorkspace>));
  await render('castle', true);
  const button = container.querySelector<HTMLButtonElement>('.landing-instructions-toggle')!;
  expect(button.disabled).toBe(true);
  act(() => button.click());
  expect(container.querySelector('[aria-label="Instructions viewer"]')).toBeNull();
  await render('castle');
  await act(async () => button.click());
  expect(button.getAttribute('aria-pressed')).toBe('true');
  await render('rover');
  expect(button.getAttribute('aria-pressed')).toBe('false');
  expect(button.textContent).toBe('Show instructions');
  expect(container.querySelector('[data-testid="viewer"]')?.textContent).toBe('rover');
});

it.each(['model', 'instructions'] as const)('expands %s and returns with the same viewer and focus', async view => {
  await act(async () => root.render(<LandingModelWorkspace model={{ generation: generation('castle'), content: 'model' }} busy={false}>{null}</LandingModelWorkspace>));
  if (view === 'instructions') await act(async () => container.querySelector<HTMLButtonElement>('.landing-instructions-toggle')!.click());
  const content = container.querySelector(view === 'model' ? '[data-testid="viewer"]' : '.landing-instructions-view');
  const expand = container.querySelector<HTMLButtonElement>('.landing-view-expand')!;
  const dialog = container.querySelector<HTMLDialogElement>('.landing-model-panel')!;
  const back = container.querySelector<HTMLButtonElement>('.landing-view-back')!;
  const overflow = document.body.style.overflow;
  expect(expand.getAttribute('aria-label')).toBe(view === 'model' ? 'Expand 3D viewer' : 'Expand instructions');
  await act(async () => expand.click());
  expect(dialog.showModal).toHaveBeenCalled();
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(dialog.dataset.expanded).toBe('true');
  expect(document.activeElement).toBe(back);
  expect(back.textContent).toBe('Back to builder');
  expect(document.body.style.overflow).toBe('hidden');
  expect(dialog.contains(content)).toBe(true);
  expect(expand.hidden).toBe(true);
  expect(posthog.capture).toHaveBeenCalledWith('landing_model_view_expanded', { generation_id: 'castle', view, source: 'viewer_footer' });
  await act(async () => back.click());
  expect(dialog.dataset.expanded).toBe('false');
  expect(dialog.open).toBe(true);
  expect(dialog.getAttribute('aria-modal')).toBeNull();
  expect(dialog.contains(content)).toBe(true);
  expect(document.body.style.overflow).toBe(overflow);
  expect(document.activeElement).toBe(expand);
  expect(posthog.capture).toHaveBeenCalledWith('landing_model_view_collapsed', { generation_id: 'castle', view, source: 'back_button' });
  expect(navigate).not.toHaveBeenCalled();
});

it('supports Escape and view switching while expanded, then restores scrolling on unmount', async () => {
  await act(async () => root.render(<LandingModelWorkspace model={{ generation: generation('castle'), content: 'model' }} busy={false}>{null}</LandingModelWorkspace>));
  const expand = container.querySelector<HTMLButtonElement>('.landing-view-expand')!;
  const dialog = container.querySelector<HTMLDialogElement>('.landing-model-panel')!;
  await act(async () => expand.click());
  await act(async () => container.querySelector<HTMLButtonElement>('.landing-instructions-toggle')!.click());
  expect(dialog.dataset.expanded).toBe('true');
  expect(dialog.getAttribute('aria-label')).toBe('Expanded instructions');
  const cancel = new Event('cancel', { cancelable: true });
  act(() => dialog.dispatchEvent(cancel));
  expect(cancel.defaultPrevented).toBe(true);
  expect(dialog.dataset.expanded).toBe('false');
  expect(dialog.dataset.view).toBe('instructions');
  expect(document.activeElement).toBe(expand);
  expect(posthog.capture).toHaveBeenCalledWith('landing_model_view_collapsed', { generation_id: 'castle', view: 'instructions', source: 'escape' });
  document.body.style.overflow = 'clip';
  await act(async () => expand.click());
  act(() => root.render(null));
  expect(document.body.style.overflow).toBe('clip');
  document.body.style.overflow = '';
});

it('returns to the inline model when the selected build changes while expanded', async () => {
  const render = (id: string) => act(async () => root.render(<LandingModelWorkspace model={{ generation: generation(id), content: id }} busy={false}>{null}</LandingModelWorkspace>));
  await render('castle');
  await act(async () => container.querySelector<HTMLButtonElement>('.landing-view-expand')!.click());
  await render('rover');
  expect(container.querySelector('.landing-model-panel')?.getAttribute('data-expanded')).toBe('false');
  expect(container.querySelector('[data-testid="viewer"]')?.textContent).toBe('rover');
  expect(document.body.style.overflow).toBe('');
});

it('shows instructions and expand controls without a share button', async () => {
  await act(async () => root.render(<LandingModelWorkspace model={{ generation: generation('castle'), content: 'model' }} busy={false}>{null}</LandingModelWorkspace>));
  const controls = container.querySelector('.landing-model-toolbar')!;
  expect(controls.querySelectorAll('button')).toHaveLength(2);
  expect(controls.querySelector('button:first-child')?.textContent).toBe('Show instructions');
  expect(controls.querySelector('button:last-child')?.getAttribute('aria-label')).toBe('Expand 3D viewer');
  expect(container.querySelector('[aria-label="Share"]')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('.landing-view-expand')!.click());
  expect(container.querySelector('[aria-label="Share"]')).toBeNull();
});

it('keeps share unavailable for pending edits and uploaded models', async () => {
  for (const [busy, endpoint] of [[true, 'novaToBricks'], [false, 'uploadLdraw']] as const) {
    await act(async () => root.render(<LandingModelWorkspace model={{ generation: generation('castle', endpoint), content: 'model' }} busy={busy}>{null}</LandingModelWorkspace>));
    expect(container.querySelector('.landing-model-share')).toBeNull();
  }
});
