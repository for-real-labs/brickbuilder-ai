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
import { LandingModelWorkspace, modelEditSuggestion } from '../src/components/LandingModelWorkspace';
import { readFileSync } from 'node:fs';

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
  requestReply: vi.fn(), updateTurn: buddy.updateTurn }) }));
vi.mock('../src/services/getGenerationStatsApi', () => ({ GetGenerationStatsApiService: { getGenerationStats: async () => ({ generation_count: 1, brick_count: 100 }) } }));
vi.mock('../src/services/getCommunityGenerationsApi', () => ({ GetCommunityGenerationsApiService: { getCommunityGenerations: async () => ({ generations: [] }) } }));
vi.mock('../src/pages/InstructionsPage', () => ({ InstructionsViewer: () => <div>Building instructions</div> }));
vi.mock('../src/components/ThreeLDRViewer', () => ({ ThreeLDRViewer: ({ modelContent, onModelLoaded }: { modelContent: string; onModelLoaded?: () => void }) => {
  viewer.loaded = onModelLoaded;
  return <div data-testid="viewer">{modelContent}</div>;
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
beforeEach(() => {
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

it('starts fresh on reload and return despite cached models, failed history, background builds and unread notifications', async () => {
  sessionStorage.setItem('brickbuilder.landing-model:guest', 'saved-castle');
  activity.rows = [
    { id: 'failed', status: 'failed', endpoint: 'novaToBricks', prompt: 'Old concert stage' },
    { id: 'pending', status: 'processing', endpoint: 'novaToBricks', prompt: 'Background car' },
    { id: 'cancelled', status: 'cancelled', endpoint: 'novaToBricks', prompt: 'Cancelled dragon' },
  ];
  inbox.notifications = [{ id: 'ready', prompt: 'Ready castle', status: 'completed', seen: false, updated_at: '2026-10-17', is_edit: false }];
  const get = vi.spyOn(GetGenerationApiService, 'getGeneration');
  const watch = vi.mocked(LlmToBricksApiService.watchOutput);
  for (let visit = 0; visit < 2; visit++) {
    await act(async () => root.render(<LandingPage />));
    expect(container.querySelector('.landing-page-intro')?.getAttribute('aria-hidden')).toBe('false');
    expect(container.querySelector('[aria-label="BrickBuilder generation statistics"]')).not.toBeNull();
    expect(container.querySelector('.pet-chat-message--user')).toBeNull();
    expect(container.querySelector('[data-testid="viewer"]')).toBeNull();
    expect(container.textContent).not.toContain('Old concert stage');
    expect(container.textContent).not.toContain('Background car');
    expect(container.textContent).not.toContain('Cancelled dragon');
    expect(container.textContent).not.toContain('Oops!');
    expect(container.textContent).toContain('Want to see');
    act(() => root.render(null));
  }
  expect(get).not.toHaveBeenCalled();
  expect(watch).not.toHaveBeenCalled();
});

it('hides stats for an explicitly linked viewer and shows them again on a plain landing visit', async () => {
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

it('floats only the model title over the viewer without intercepting viewer gestures', async () => {
  const style = document.createElement('style');
  style.textContent = readFileSync('src/components/LandingModelWorkspace.css', 'utf8');
  document.head.append(style);
  try {
    await act(async () => root.render(<LandingModelWorkspace model={{ generation: generation('castle'), content: 'model' }} busy={false}><div>Conversation</div></LandingModelWorkspace>));
    const heading = container.querySelector<HTMLElement>('.landing-model-heading')!;
    expect(getComputedStyle(heading).position).toBe('absolute');
    expect(getComputedStyle(heading).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(getComputedStyle(heading).pointerEvents).toBe('none');
    expect(heading.textContent).toBe('Castle');
    expect(heading.querySelector('button')).toBeNull();
  } finally { style.remove(); }
});

it('loads the linked model instead of the saved workspace or newest dashboard generation', async () => {
  query.value = 'id=linked%20%26%20model&exact=1';
  sessionStorage.setItem('brickbuilder.landing-model:guest', 'saved');
  activity.rows = [{ id: 'newest', status: 'completed', endpoint: 'novaToBricks', prompt: 'Newest' }];
  const get = vi.spyOn(GetGenerationApiService, 'getGeneration').mockImplementation(async id => ({ ...generation(id), name: id }));
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('.landing-model-name')?.textContent).toBe('linked & model');
  expect(container.querySelector('[data-testid="viewer"]')?.textContent).toBe('castle mpd');
  expect(get.mock.calls.every(([id]) => id === 'linked & model')).toBe(true);
  expect(sessionStorage.getItem('brickbuilder.landing-model:guest')).toBe('linked & model');
});

it('loads a different model when the landing link changes and clears the link when creating a new model', async () => {
  query.value = 'id=first&exact=1&campaign=share';
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockImplementation(async id => ({ ...generation(id), name: id }));
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('.landing-model-name')?.textContent).toBe('first');
  query.value = 'id=second&exact=1&campaign=share';
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('.landing-model-name')?.textContent).toBe('second');
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
  const loading = container.querySelector('[aria-label="Loading your model"]')!;
  expect(loading.getAttribute('role')).toBe('status');
  expect(loading.querySelector('.brick-build-scene')).not.toBeNull();
  expect(loading.textContent).toContain('Your model will appear here');
  expect(loading.closest('.landing-model-conversation')).toBeNull();
  expect(container.querySelector('.landing-model-conversation')?.textContent).not.toContain('Your model will appear here');
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
  expect(input().getAttribute('aria-label')).toBe('Describe your model');
  expect(container.querySelector('[aria-label="Upload image"]')).not.toBeNull();
  expect(input().value).toBe('');
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(container.querySelector('[aria-label="Model suggestions"]')).toBeNull();
  expect(posthog.capture).toHaveBeenCalledWith('landing_model_create_new_clicked', { generation_id: 'castle' });
});

it.each(['llmToBricks', 'novaToBricks', 'textTo3d'])('keeps the %s generation card and cancellation inside the scrolling dialogue', async endpoint => {
  query.value = 'id=building&exact=1';
  activity.rows = [{ id: 'building', status: 'processing', endpoint, prompt: 'A cat', createdAt: new Date().toISOString() }];
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue({ ...generation('building', endpoint), status: 'processing' });
  const cancel = vi.spyOn(GetGenerationApiService, 'cancelGeneration').mockResolvedValue(undefined);
  await act(async () => root.render(<LandingPage />));
  const conversation = container.querySelector('[aria-label="Build buddy conversation"]')!;
  const card = conversation.querySelector('article')!;
  expect(card).not.toBeNull();
  expect(card.textContent).toContain('A cat');
  expect(container.querySelectorAll('[aria-label="Your generations"]')).toHaveLength(1);
  expect(conversation.contains(container.querySelector('[aria-label="Your generations"]'))).toBe(true);
  expect(conversation.compareDocumentPosition(input()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const cancelButton = Array.from(card.querySelectorAll('button')).find(button => button.textContent === 'Cancel generation')!;
  await act(async () => cancelButton.click());
  expect(cancel).toHaveBeenCalledExactlyOnceWith('building');
  expect(activity.track).toHaveBeenCalledWith(expect.objectContaining({ id: 'building', status: 'cancelled' }));
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
  expect(container.querySelector('.landing-model-heading button')).toBeNull();
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
  expect(container.querySelector('.landing-page-intro')?.getAttribute('aria-hidden')).toBe('false');
  expect(container.querySelector('[aria-label="Choose LDraw file"]')).not.toBeNull();
  expect(container.querySelector('.landing-page')).toBeNull();
});

it.each(['novaToBricks', 'llmToBricks', 'uploadLdraw'])('edits %s through its source API and retains the viewer until the replacement is ready', async endpoint => {
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
  await submit(); await submit();
  if (endpoint === 'llmToBricks') {
    expect(llm).toHaveBeenCalledExactlyOnceWith({ sourceGenerationId: 'castle', prompt: 'Add a drawbridge' }, undefined);
    expect(nova).not.toHaveBeenCalled();
  } else {
    expect(nova).toHaveBeenCalledExactlyOnceWith('castle', 'Add a drawbridge', undefined);
    expect(llm).not.toHaveBeenCalled();
  }
  expect(container.querySelector('[data-testid="viewer"]')).not.toBeNull();
  expect(input().disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('.landing-create-new')!.disabled).toBe(true);
  expect(container.textContent).toContain('Updating your model');
  ready = true;
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(input().disabled).toBe(false);
  expect(container.querySelector('[aria-label="Model suggestions"]')).toBeNull();
  expect(container.querySelector('.landing-model-name')?.textContent).toBe('Castle with bridge');
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

it('uses an edit placeholder for model links without cycling build suggestions', async () => {
  query.value = 'id=castle&exact=1';
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue(generation('castle'));
  await act(async () => root.render(<LandingPage />));
  expect(input().placeholder).toBe('Tell me what you’d like to change…');
  type('Add a flag'); type('');
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(input().placeholder).toBe('Tell me what you’d like to change…');
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


it('shows the shared LEGO animation only while opening a model, and keeps an existing model visible during edits', async () => {
  const render = (model: LandingModel | null, loading: boolean, busy = loading) => act(async () => root.render(
    <LandingModelWorkspace model={model} loading={loading} busy={busy}><p>Conversation</p></LandingModelWorkspace>));
  await render(null, false);
  expect(container.querySelector('.landing-model-loading')).toBeNull();
  await render(null, false, true);
  expect(container.querySelector('.landing-model-loading')).toBeNull();
  await render(null, true);
  expect(container.querySelectorAll('.landing-model-loading .brick-build-scene')).toHaveLength(1);
  const initialScene = container.querySelector('.landing-model-loading svg');
  await act(async () => vi.advanceTimersByTimeAsync(6800));
  expect(container.querySelector('.landing-model-loading svg')).not.toBe(initialScene);
  await render({ generation: generation('castle'), content: 'castle mpd' }, true);
  expect(container.querySelector('.landing-model-loading')).toBeNull();
  expect(container.querySelector('[data-testid="viewer"]')).not.toBeNull();
});

it.each(['failed', 'cancelled'] as const)('removes the centered loading state after a linked build is %s', async status => {
  query.value = 'id=castle&exact=1';
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue({ ...generation('castle'), status });
  await act(async () => root.render(<LandingPage />));
  expect(container.querySelector('.landing-model-loading')).toBeNull();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
});
