import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import LandingPage from '../src/pages/LandingPage';
import { GetGenerationApiService, type GetGenerationResponse } from '../src/services/getGenerationApi';
import { LdrToMpdApiService } from '../src/services/ldrToMpdApi';
import { NovaToBricksApiService } from '../src/services/novaToBricksApi';
import { LlmToBricksApiService } from '../src/services/llmToBricksApi';
import { useLandingModel, type LandingModel } from '../src/hooks/useLandingModel';
import type { GenerationActivity } from '../src/hooks/useGenerationActivity';
import { modelEditSuggestions } from '../src/components/LandingModelWorkspace';

const activity = vi.hoisted(() => ({ rows: [] as GenerationActivity[], track: vi.fn() }));
const buddy = vi.hoisted(() => ({ updateTurn: vi.fn() }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => ({ session: null, loading: false }) }));
vi.mock('../src/hooks/useGenerationActivity', async () => ({
  ...await vi.importActual('../src/hooks/useGenerationActivity'),
  useGenerationActivity: () => ({ generations: activity.rows, trackGeneration: activity.track, dismissGeneration: vi.fn() }),
}));
vi.mock('../src/services/localProvidersApi', () => ({ isLocalDevelopment: () => false }));
vi.mock('../src/hooks/useBuildBuddyChat', () => ({ useBuildBuddyChat: () => ({ turns: [], startTurn: () => 1, requestReply: vi.fn(), updateTurn: buddy.updateTurn }) }));
vi.mock('../src/services/getGenerationStatsApi', () => ({ GetGenerationStatsApiService: { getGenerationStats: async () => ({ generation_count: 1, brick_count: 100 }) } }));
vi.mock('../src/services/getCommunityGenerationsApi', () => ({ GetCommunityGenerationsApiService: { getCommunityGenerations: async () => ({ generations: [] }) } }));
vi.mock('../src/components/ThreeLDRViewer', () => ({ ThreeLDRViewer: ({ modelContent }: { modelContent: string }) => <div data-testid="viewer">{modelContent}</div> }));
vi.mock('../src/components/FallingBricks', () => ({ default: () => null }));
vi.mock('../src/components/SEO', () => ({ SEO: () => null }));
vi.mock('../src/components/LoginModal', () => ({ default: () => null }));
vi.mock('../src/components/SiteFooter', () => ({ SiteFooter: () => null }));
vi.mock('../src/components/ProfileMenu', () => ({ ProfileMenu: () => null }));
vi.mock('../src/components/NotificationMenu', () => ({ NotificationMenu: () => null }));
vi.mock('../src/components/GenerationActivityList', () => ({ GenerationActivityList: () => null }));
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
  buddy.updateTurn.mockClear();
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
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const input = () => container.querySelector<HTMLInputElement>('#landing-build-prompt')!;
function type(text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const submit = () => act(async () => container.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

it('shows a newly completed build inline, puts three suggestions above the dialogue, and resets without reopening old builds', async () => {
  vi.spyOn(NovaToBricksApiService, 'generate').mockResolvedValue({ generation_id: 'castle', message: 'Started' });
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue(generation('castle'));
  await act(async () => root.render(<LandingPage />));
  type('A castle'); await submit();
  expect(container.querySelector('[data-testid="viewer"]')?.textContent).toBe('castle mpd');
  const suggestions = container.querySelector('[aria-label="Model suggestions"]')!;
  const buttons = Array.from(suggestions.querySelectorAll('button'));
  expect(buttons).toHaveLength(3);
  expect(buttons[0].textContent).toBe('Add a drawbridge');
  expect(buttons[1].textContent).toContain('Castle');
  expect(buttons[2].textContent).toBe('Create new?');
  const conversation = container.querySelector('[aria-label="Build buddy conversation"]')!;
  expect(suggestions.compareDocumentPosition(conversation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(conversation.closest('.landing-model-conversation')).not.toBeNull();
  expect(container.querySelector('a[href="/generated-model?id=castle&exact=1"]')).not.toBeNull();
  act(() => buttons[0].click());
  expect(input().value).toBe('Add a drawbridge');
  expect(document.activeElement).toBe(input());
  act(() => buttons[2].click());
  expect(container.querySelector('[data-testid="viewer"]')).toBeNull();
  expect(input().getAttribute('aria-label')).toBe('Describe your model');
  expect(input().value).toBe('');
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(container.querySelector('[aria-label="Model suggestions"]')).toBeNull();
  expect(posthog.capture).toHaveBeenCalledWith('landing_model_create_new_clicked', { generation_id: 'castle' });
});

it.each(['novaToBricks', 'llmToBricks', 'uploadLdraw'])('edits %s through its source API and retains the viewer until the replacement is ready', async endpoint => {
  activity.rows = [{ id: 'castle', status: 'completed', endpoint, prompt: 'Castle' }];
  let ready = false;
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockImplementation(async id => id === 'castle'
    ? generation(id, endpoint) : { ...generation(id, endpoint), name: 'Castle with bridge', status: ready ? 'completed' : 'processing', example_edit_prompt: 'Add flags' });
  const nova = vi.spyOn(NovaToBricksApiService, 'edit').mockResolvedValue({ generation_id: 'edited', message: 'Started' });
  const llm = vi.spyOn(LlmToBricksApiService, 'generate').mockResolvedValue({ generation_id: 'edited', message: 'Started' });
  await act(async () => root.render(<LandingPage />));
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Model suggestions"] button')!.click());
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
  expect(container.textContent).toContain('Updating your model');
  ready = true;
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(input().disabled).toBe(false);
  expect(container.querySelector('[aria-label="Model suggestions"] button')?.textContent).toBe('Add flags');
  expect(container.querySelector('a[href="/generated-model?id=edited&exact=1"]')).not.toBeNull();
});

it('keeps the current model and edit text available after an edit request fails', async () => {
  activity.rows = [{ id: 'castle', status: 'completed', prompt: 'Castle' }];
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue(generation('castle'));
  vi.spyOn(NovaToBricksApiService, 'edit').mockRejectedValue(new Error('Please try again'));
  await act(async () => root.render(<LandingPage />));
  type('Add a bridge'); await submit();
  expect(container.querySelector('[data-testid="viewer"]')).not.toBeNull();
  expect(input().value).toBe('Add a bridge');
  expect(input().disabled).toBe(false);
  expect(buddy.updateTurn).toHaveBeenCalledWith(1, {
    error: 'Woops! Something in the brickverse is down. Try again later', reply: undefined,
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

it('restores the workspace for the same owner and clears the displayed model when accounts change', async () => {
  let model!: ReturnType<typeof useLandingModel>;
  function Probe({ owner }: { owner: string }) { model = useLandingModel(owner); return null; }
  sessionStorage.setItem('brickbuilder.landing-model:builder', 'castle');
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue(generation('castle'));
  await act(async () => root.render(<Probe owner="builder" />));
  expect(model.model?.generation.generation_id).toBe('castle');
  await act(async () => root.render(<Probe owner="someone-else" />));
  expect(model.model).toBeNull();
  expect(model.targetId).toBeNull();
  await act(async () => root.render(<Probe owner="builder" />));
  expect(model.model?.generation.generation_id).toBe('castle');
  act(() => model.reset());
  expect(sessionStorage.getItem('brickbuilder.landing-model:builder')).toBeNull();
});

it('provides two distinct model suggestions when an example is missing or matches the detail suggestion', () => {
  const model: LandingModel = { generation: { ...generation('castle'), example_edit_prompt: null }, content: 'mpd' };
  expect(modelEditSuggestions(model)).toEqual(['Change the colors of the Castle', 'Add more detail to the Castle']);
  model.generation.example_edit_prompt = 'Add more detail to the Castle';
  expect(new Set(modelEditSuggestions(model)).size).toBe(2);
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
