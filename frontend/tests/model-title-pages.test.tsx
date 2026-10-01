import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { GetGenerationApiService } from '../src/services/getGenerationApi';
import { LdrToMpdApiService } from '../src/services/ldrToMpdApi';
import { GetPriceApiService } from '../src/services/getPriceApi';
import { GenerationNotificationsApi } from '../src/services/generationNotificationsApi';
import { GetGenerationLikeStatusApiService } from '../src/services/getGenerationLikeStatusApi';
import { UpdateGenerationNameApiService } from '../src/services/updateGenerationNameApi';
import GeneratedModel from '../src/pages/GeneratedModel';
import OrderKit from '../src/pages/OrderKit';
import { GenerationCard } from '../src/pages/UserDashboard';
import { LlmToBricksApiService } from '../src/services/llmToBricksApi';
import { GetGenerationsByImageApiService } from '../src/services/getGenerationsByImageApi';

const mocks = vi.hoisted(() => ({ owner: 'owner', user: {id: 'owner'}, refresh: vi.fn(), markViewed: vi.fn(), query: vi.fn() }));
vi.mock('../src/contexts/AuthContext', () => ({useAuth: () => ({user: mocks.user, userProfile: null, isSupabaseConfigured: true})}));
vi.mock('../src/contexts/GenerationNotificationsContext', () => ({useGenerationNotifications: () => ({refresh: mocks.refresh, markViewed: mocks.markViewed})}));
vi.mock('../src/components/ThreeLDRViewer', () => ({ThreeLDRViewer: ({modelName, onModelLoaded, topLeftOverlay}: {modelName: string; onModelLoaded?: () => void; topLeftOverlay?: React.ReactNode}) => {
  React.useEffect(() => { onModelLoaded?.(); }, [modelName]);
  return <><div data-testid="viewer">{modelName}</div>{topLeftOverlay}</>;
}}));
vi.mock('../src/components/VoxelViewer', () => ({VoxelViewer: () => null}));
vi.mock('../src/components/SEO', () => ({SEO: () => null}));
vi.mock('../src/components/SiteFooter', () => ({SiteFooter: () => null}));
vi.mock('../src/components/ProfileMenu', () => ({ProfileMenu: () => null}));
vi.mock('../src/components/NotificationMenu', () => ({NotificationMenu: () => null}));
vi.mock('../src/components/LoginModal', () => ({default: () => null}));
vi.mock('posthog-js', () => ({default: {capture: vi.fn()}}));
vi.mock('../src/lib/supabase', () => ({supabase: {
  auth: {getSession: async () => ({data: {session: {access_token: 'token'}}})},
  from: () => ({select: () => ({eq: () => ({maybeSingle: mocks.query})})}),
}}));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  mocks.user = {id: 'owner'};
  mocks.query.mockImplementation(async () => ({data: {user_id: mocks.owner, is_community: true, preview_image_url: '/preview.png'}, error: null}));
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue({generation_id: 'g', status: 'completed', name: 'Sunny Dachshund', prompt: 'please create a dachshund in sunglasses, with lots of details', ldr_content: 'ldr'} as never);
  vi.spyOn(LdrToMpdApiService, 'convertLdrToMpd').mockResolvedValue({mpd_content: 'mpd'} as never);
  vi.spyOn(GetPriceApiService, 'getPrice').mockRejectedValue(new Error('No estimate'));
  vi.spyOn(GenerationNotificationsApi, 'latestEdit').mockResolvedValue({generation_id: null});
  vi.spyOn(GetGenerationLikeStatusApiService, 'getGenerationLikeStatus').mockResolvedValue({is_community: true, like_count: 0, viewer_has_liked: false});
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok: true, json: async () => ({stargazers_count: 0})}));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it.each(['owner', 'other'])('renders the saved title on the model page and gates renaming for %s', async viewer => {
  mocks.owner = 'owner'; mocks.user = {id: viewer};
  await act(async () => root.render(<MemoryRouter initialEntries={['/generated-model?id=g&exact=1']}><GeneratedModel /></MemoryRouter>));
  expect(container.querySelector('h1')?.textContent).toBe('Sunny Dachshund');
  expect(!!container.querySelector('[aria-label="Rename model"]')).toBe(viewer === 'owner');
});

it('updates the model title after an owner rename and uses it on the order page', async () => {
  const save = vi.spyOn(UpdateGenerationNameApiService, 'updateGenerationName').mockResolvedValue({generation_id: 'g', name: 'My Sunny Dog'});
  mocks.owner = 'owner';
  await act(async () => root.render(<MemoryRouter initialEntries={['/generated-model?id=g&exact=1']}><GeneratedModel /></MemoryRouter>));
  act(() => (container.querySelector('[aria-label="Rename model"]') as HTMLButtonElement).click());
  act(() => {
    const input = container.querySelector('#model-name')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'My Sunny Dog');
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
  expect(save).toHaveBeenCalledOnce();
  expect(container.querySelector('h1')?.textContent).toBe('My Sunny Dog');
  expect(localStorage.getItem('lastModelName')).toBe('My Sunny Dog');
  vi.mocked(GetGenerationApiService.getGeneration).mockResolvedValue({generation_id:'g', status:'completed', name:'My Sunny Dog', prompt:'original prompt', ldr_content:'ldr'} as never);
  await act(async () => root.render(<MemoryRouter key="order" initialEntries={[{pathname:'/order', state: {generation_id:'g', name:'Stale Name'}}]}><OrderKit /></MemoryRouter>));
  expect(container.querySelector('h1')?.textContent).toBe('My Sunny Dog');
  expect(container.querySelector('[data-testid="viewer"]')?.textContent).toBe('My Sunny Dog');
});

it('shows the saved server title on /order even when navigation contains an old name', async () => {
  await act(async () => root.render(<MemoryRouter initialEntries={[{pathname:'/order', state: {generation_id:'g', name:'Old Title'}}]}><OrderKit /></MemoryRouter>));
  expect(container.querySelector('h1')?.textContent).toBe('Sunny Dachshund');
  expect(LdrToMpdApiService.convertLdrToMpd).toHaveBeenCalledWith('ldr', 'Sunny Dachshund', 'token');
});

const revisionHistory = [
  {id: 'old', generation_id: 'root', version: 3, status: 'completed', created_at: '2026-10-01', prompt: 'rover'},
  {id: 'g', generation_id: 'root', version: 7, status: 'completed', created_at: '2026-09-30', prompt: 'rover'},
];

it('shows image-free LLM history ordered and labelled by stored version on the model page', async () => {
  const history = vi.spyOn(GetGenerationsByImageApiService, 'getGenerationsByImage').mockResolvedValue({generations: revisionHistory, total_count: 2});
  await act(async () => root.render(<MemoryRouter initialEntries={['/generated-model?id=g&exact=1']}><GeneratedModel /></MemoryRouter>));
  const button = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('Previous edits'))!;
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(history).toHaveBeenCalledWith('token', 'g');
  const dialog = container.querySelector('[aria-label="Previous model edits"]')!;
  expect(dialog.textContent!.indexOf('Version 7')).toBeLessThan(dialog.textContent!.indexOf('Version 3'));
  expect(dialog.querySelector('a')?.getAttribute('href')).toBe('/generated-model?id=old&exact=1');
});

it('shows image-free history on dashboard cards and opens the selected revision exactly', async () => {
  const history = vi.spyOn(GetGenerationsByImageApiService, 'getGenerationsByImage').mockResolvedValue({generations: revisionHistory, total_count: 2});
  const Location = () => { const location = useLocation(); return <output>{location.pathname}{location.search}</output>; };
  await act(async () => root.render(<MemoryRouter><GenerationCard
    g={{id: 'g', generation_id: 'root', version: 7, prompt: 'rover', user_id: 'owner', user_type: 'authenticated', status: 'completed', endpoint: 'llmToBricks', created_at: '2026-09-30', detail_level: 30}}
    onView={vi.fn()} authToken="token"
  /><Location /></MemoryRouter>));
  const button = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('View Edits'))!;
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(history).toHaveBeenCalledWith('token', 'g');
  expect(container.textContent!.indexOf('VERSION 7')).toBeLessThan(container.textContent!.indexOf('VERSION 3'));
  const viewButtons = Array.from(container.querySelectorAll('button')).filter(button => button.textContent?.includes('View Model'));
  await act(async () => viewButtons.at(-1)!.click());
  expect(container.querySelector('output')?.textContent).toBe('/generated-model?id=old&exact=1');
});

it('opens the earlier completed version after cancellation without a stored source link', async () => {
  vi.mocked(GetGenerationApiService.getGeneration).mockImplementation(async id => (
    id === 'g' ? {generation_id: 'g', model_generation_id: 'root', version: 4,
      status: 'cancelled', previous_completed_generation_id: 'old'} :
      {generation_id: 'old', model_generation_id: 'root', version: 2,
        status: 'completed', name: 'Earlier Rover', ldr_content: 'ldr'}
  ) as never);
  const Location = () => { const location = useLocation(); return <output>{location.pathname}{location.search}</output>; };
  await act(async () => root.render(<MemoryRouter initialEntries={['/generated-model?id=g&exact=1']}><GeneratedModel /><Location /></MemoryRouter>));
  expect(container.querySelector('output')?.textContent).toBe('/generated-model?id=old&exact=1');
  expect(container.querySelector('h1')?.textContent).toBe('Earlier Rover');
});


const completedEditSource = {
  generation_id: 'old', status: 'completed', name: 'Pepsi Can', prompt: 'Pepsi can',
  ldr_content: 'original ldr', mpd_url: null, xyzrgb_url: '/voxels.txt',
  problematic_xyzrgb_url: null, processed_image_url: null, detail_level: 1,
} as const;
const pendingEdit = {
  ...completedEditSource, generation_id: 'g', status: 'processing', endpoint: 'llmToBricks',
  version: 2, previous_completed_generation_id: 'old', ldr_content: null,
} as const;

function mockPendingEdit() {
  vi.mocked(GetGenerationApiService.getGeneration).mockImplementation(async id =>
    (id === 'old' ? completedEditSource : pendingEdit) as never);
  vi.spyOn(GetPriceApiService, 'getPrice').mockResolvedValue({
    generation_id: 'old', total_price: 60, total_parts: 120, total_weight: 0.2,
    currency: 'USD', parts_breakdown: [],
  } as never);
  vi.spyOn(LlmToBricksApiService, 'watchOutput').mockImplementation(async (_id, onOutput, signal) => {
    onOutput({text: 'Adjusting the size of the can', summary: 'Shrinking the Pepsi can', status: 'processing'});
    return new Promise(resolve => signal?.addEventListener('abort', () => resolve(true), {once: true}));
  });
}

function modelButton(label: string) {
  return container.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;
}

it('keeps the complete page visible on a resumed edit and locks only model changes and purchases', async () => {
  mockPendingEdit();
  vi.spyOn(GetGenerationApiService, 'pollUntilComplete').mockImplementation(() => new Promise(() => {}));
  await act(async () => root.render(<MemoryRouter initialEntries={['/generated-model?id=g&exact=1']}><GeneratedModel /></MemoryRouter>));

  expect(container.querySelector('h1')?.textContent).toBe('Pepsi Can');
  expect(container.querySelector('[data-testid="viewer"]')).not.toBeNull();
  expect(container.textContent).toContain('120 Pieces');
  expect(container.textContent).toContain('Shrinking the Pepsi can');
  expect(container.textContent).not.toContain('Continue browsing');
  expect(container.querySelector('[data-testid="viewer"]')?.closest('figure')?.textContent).toContain('Cancel edit');
  expect(modelButton('Edit model').disabled).toBe(true);
  expect(modelButton('Edit model').textContent).toBe('Edit');
  expect(modelButton('Remove from community').disabled).toBe(true);
  expect(modelButton('Order my kit').disabled).toBe(true);
  expect((container.querySelector('#voxel-edit-prompt') as HTMLTextAreaElement).disabled).toBe(true);
  expect(modelButton('Order this model').disabled).toBe(true);
  expect(modelButton('View instructions').disabled).toBe(false);
  expect(modelButton('Export model').disabled).toBe(false);
  expect(modelButton('Like community model').disabled).toBe(false);
  expect(container.querySelector('[data-testid="viewer"]')?.closest('section')?.nextElementSibling?.getAttribute('style')).not.toContain('opacity: 0');
});

it('keeps the mounted viewer when submitting an edit and while the edit request starts', async () => {
  mockPendingEdit();
  let startEdit!: (value: {generation_id: string}) => void;
  vi.spyOn(LlmToBricksApiService, 'generate').mockImplementation(() => new Promise(resolve => { startEdit = resolve; }));
  vi.spyOn(GetGenerationApiService, 'pollUntilComplete').mockImplementation(() => new Promise(() => {}));
  await act(async () => root.render(<MemoryRouter initialEntries={['/generated-model?id=old&exact=1']}><GeneratedModel /></MemoryRouter>));
  const viewer = container.querySelector('[data-testid="viewer"]');
  act(() => {
    const textarea = container.querySelector('#voxel-edit-prompt')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Shrink the can');
    textarea.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await act(async () => container.querySelector('#voxel-edit-prompt')!.closest('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
  expect(container.querySelector('[data-testid="viewer"]')).toBe(viewer);
  expect(modelButton('Edit model').disabled).toBe(true);
  expect(modelButton('Order my kit').disabled).toBe(true);
  await act(async () => startEdit({generation_id: 'g'}));
  expect(container.querySelector('[data-testid="viewer"]')).toBe(viewer);
  expect(container.textContent).toContain('Shrinking the Pepsi can');
  expect(container.textContent).not.toContain('Continue browsing');
});

it('replaces the model and unlocks actions when the edit completes', async () => {
  mockPendingEdit();
  let complete!: (value: unknown) => void;
  vi.spyOn(GetGenerationApiService, 'pollUntilComplete').mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  await act(async () => root.render(<MemoryRouter initialEntries={['/generated-model?id=g&exact=1']}><GeneratedModel /></MemoryRouter>));
  await act(async () => complete({...completedEditSource, generation_id: 'g', name: 'Small Pepsi Can', ldr_content: 'edited ldr'}));
  expect(container.querySelector('h1')?.textContent).toBe('Small Pepsi Can');
  expect(container.querySelector('[data-testid="viewer"]')?.textContent).toBe('Small Pepsi Can');
  expect(LdrToMpdApiService.convertLdrToMpd).toHaveBeenCalledWith('edited ldr', 'Small Pepsi Can', 'token');
  expect(container.textContent).not.toContain('Cancel edit');
  expect(modelButton('Edit model').disabled).toBe(false);
  expect(modelButton('Remove from community').disabled).toBe(false);
  expect(modelButton('Order my kit').disabled).toBe(false);
});

it('cancels the pending edit and retains the previous completed model', async () => {
  mockPendingEdit();
  const cancel = vi.spyOn(GetGenerationApiService, 'cancelGeneration').mockResolvedValue();
  const poll = vi.spyOn(GetGenerationApiService, 'pollUntilComplete').mockImplementation(() => new Promise(() => {}));
  await act(async () => root.render(<MemoryRouter initialEntries={['/generated-model?id=g&exact=1']}><GeneratedModel /></MemoryRouter>));
  const cancelButton = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Cancel edit')!;
  await act(async () => cancelButton.click());
  expect(cancel).toHaveBeenCalledWith('g');
  expect(poll.mock.calls[0][4]?.aborted).toBe(true);
  expect(container.querySelector('h1')?.textContent).toBe('Pepsi Can');
  expect(container.textContent).not.toContain('Cancel edit');
  expect(modelButton('Edit model').disabled).toBe(false);
  expect(modelButton('Order my kit').disabled).toBe(false);
});

it('keeps the source model available and unlocks controls after an edit fails', async () => {
  mockPendingEdit();
  vi.spyOn(GetGenerationApiService, 'pollUntilComplete').mockRejectedValue(new Error('Edit interrupted'));
  await act(async () => root.render(<MemoryRouter initialEntries={['/generated-model?id=g&exact=1']}><GeneratedModel /></MemoryRouter>));
  expect(container.querySelector('h1')?.textContent).toBe('Pepsi Can');
  expect(container.textContent).toContain('Edit interrupted');
  expect(container.textContent).not.toContain('Failed to Load Model');
  expect(modelButton('Edit model').disabled).toBe(false);
  expect(modelButton('Order my kit').disabled).toBe(false);
});


it('keeps the previous model and actions locked until the completed edit preview finishes loading', async () => {
  mockPendingEdit();
  let complete!: (value: unknown) => void;
  let previewReady!: (value: unknown) => void;
  vi.spyOn(GetGenerationApiService, 'pollUntilComplete').mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  await act(async () => root.render(<MemoryRouter initialEntries={['/generated-model?id=g&exact=1']}><GeneratedModel /></MemoryRouter>));
  vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { previewReady = resolve; }));
  await act(async () => complete({...completedEditSource, generation_id: 'g', name: 'Small Pepsi Can', mpd_url: '/edited.mpd'}));
  expect(container.querySelector('h1')?.textContent).toBe('Pepsi Can');
  expect(modelButton('Order my kit').disabled).toBe(true);
  expect(modelButton('Edit model').disabled).toBe(true);
  await act(async () => previewReady({ok: true, text: async () => 'edited mpd'}));
  expect(container.querySelector('h1')?.textContent).toBe('Small Pepsi Can');
  expect(modelButton('Order my kit').disabled).toBe(false);
});

it('keeps the full generation loader for a first build without a completed source', async () => {
  mockPendingEdit();
  vi.mocked(GetGenerationApiService.getGeneration).mockResolvedValue({...pendingEdit, version: 1, previous_completed_generation_id: null} as never);
  vi.spyOn(GetGenerationApiService, 'pollUntilComplete').mockImplementation(() => new Promise(() => {}));
  await act(async () => root.render(<MemoryRouter initialEntries={['/generated-model?id=g&exact=1']}><GeneratedModel /></MemoryRouter>));
  expect(container.querySelector('[data-testid="viewer"]')).toBeNull();
  expect(container.textContent).toContain('Continue browsing');
  expect(container.textContent).toContain('Cancel generation');
});
