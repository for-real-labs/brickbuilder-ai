import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
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
import { GetGenerationsByImageApiService } from '../src/services/getGenerationsByImageApi';
import { getGeneratedModelPath } from '../src/utils/generationRoutes';
import posthog from 'posthog-js';

const mocks = vi.hoisted(() => ({ owner: 'owner', user: {id: 'owner'}, refresh: vi.fn(), markViewed: vi.fn(), query: vi.fn() }));
vi.mock('../src/contexts/AuthContext', () => ({useAuth: () => ({user: mocks.user, userProfile: null, isSupabaseConfigured: true})}));
vi.mock('../src/contexts/GenerationNotificationsContext', () => ({useGenerationNotifications: () => ({refresh: mocks.refresh, markViewed: mocks.markViewed})}));
vi.mock('../src/components/ThreeLDRViewer', () => ({ThreeLDRViewer: ({modelName}: {modelName: string}) => <div data-testid="viewer">{modelName}</div>}));
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

const pendingEdit = {
  id: 'pending', generation_id: 'root', version: 5, prompt: 'Make it a Pepsi can',
  user_id: 'owner', user_type: 'authenticated', status: 'processing', endpoint: 'llmToBricks',
  created_at: '2026-10-01', detail_level: 30,
  preview_image_url: '/unfinished.png',
  previous_completed_generation_id: 'completed-v2',
  previous_completed_preview_image_url: '/completed-v2.png',
};

it.each(['queued', 'started', 'processing', 'ldr_processing', 'resizing'])(
  'keeps the completed preview and model actions available during %s', async status => {
    const onView = vi.fn();
    await act(async () => root.render(<MemoryRouter><GenerationCard g={{...pendingEdit, status}} onView={onView} /></MemoryRouter>));
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/completed-v2.png');
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Processing...');
    const view = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('View Model'))!;
    expect(view.disabled).toBe(false);
    act(() => view.click());
    expect(onView).toHaveBeenCalledWith('completed-v2', true);
    expect(posthog.capture).toHaveBeenCalledWith('dashboard_generation_viewed', {
      generation_id: 'pending', viewed_generation_id: 'completed-v2', status,
    });
  },
);

it('opens the last completed model from its dashboard thumbnail while a newer edit is active', async () => {
  vi.mocked(GetGenerationApiService.getGeneration).mockResolvedValue({
    generation_id: 'completed-v2', status: 'completed', name: 'Completed Can', ldr_content: 'ldr',
  } as never);
  vi.mocked(GenerationNotificationsApi.latestEdit).mockResolvedValue({generation_id: 'pending'});
  const DashboardCard = () => {
    const navigate = useNavigate();
    return <GenerationCard g={pendingEdit} onView={(id, exact) => navigate(getGeneratedModelPath(id, exact))} />;
  };
  const Location = () => { const location = useLocation(); return <output>{location.pathname}{location.search}</output>; };
  await act(async () => root.render(<MemoryRouter initialEntries={['/dashboard']}>
    <Routes>
      <Route path="/dashboard" element={<DashboardCard />} />
      <Route path="/generated-model" element={<GeneratedModel />} />
    </Routes><Location />
  </MemoryRouter>));
  await act(async () => (container.querySelector('[aria-label="View model preview"]') as HTMLButtonElement).click());
  expect(container.querySelector('output')?.textContent).toBe('/generated-model?id=completed-v2&exact=1');
  expect(container.querySelector('[data-testid="viewer"]')?.textContent).toBe('Completed Can');
  expect(GetGenerationApiService.getGeneration).toHaveBeenCalledWith('completed-v2', expect.any(AbortSignal));
});

it('keeps an initial generation without a completed revision unavailable', async () => {
  const onView = vi.fn();
  await act(async () => root.render(<MemoryRouter><GenerationCard g={{
    ...pendingEdit, version: 1, previous_completed_generation_id: null, previous_completed_preview_image_url: null,
  }} onView={onView} /></MemoryRouter>));
  const preview = container.querySelector('[aria-label="View model preview"]') as HTMLButtonElement;
  expect(preview.disabled).toBe(true);
  expect(Array.from(container.querySelectorAll('button')).some(button => button.textContent?.includes('View Model'))).toBe(false);
  act(() => preview.click());
  expect(onView).not.toHaveBeenCalled();
});

it('uses the new revision preview and regular navigation once the edit completes', async () => {
  const onView = vi.fn();
  await act(async () => root.render(<MemoryRouter><GenerationCard g={{...pendingEdit, status: 'completed'}} onView={onView} /></MemoryRouter>));
  expect(container.querySelector('img')?.getAttribute('src')).toBe('/unfinished.png');
  expect(container.querySelector('[role="status"]')).toBeNull();
  act(() => (container.querySelector('[aria-label="View model preview"]') as HTMLButtonElement).click());
  expect(onView).toHaveBeenCalledWith('pending', false);
});

it('places Manually Edit inside the edit form, opens the block editor, and pulses the Order action', async () => {
  vi.mocked(GetGenerationApiService.getGeneration).mockResolvedValue({
    generation_id: 'g', status: 'completed', name: 'Sunny Dachshund', ldr_content: 'ldr', xyzrgb_url: '/voxels.xyzrgb',
  } as never);
  vi.mocked(fetch).mockResolvedValue({ok: true, text: async () => '0 0 0 255 0 0', json: async () => ({stargazers_count: 0})} as never);
  await act(async () => root.render(<MemoryRouter initialEntries={['/generated-model?id=g&exact=1']}><GeneratedModel /></MemoryRouter>));
  const editForm = container.querySelector('#voxel-edit-prompt')!.closest('form')!;
  const manualButtons = container.querySelectorAll('[aria-label="Manually edit model"]');
  expect(manualButtons).toHaveLength(1);
  expect(editForm.contains(manualButtons[0])).toBe(true);
  const order = container.querySelector('[aria-label="Order my kit"]') as HTMLButtonElement;
  expect(order.disabled).toBe(false);
  expect(order.classList.contains('attention-pulse')).toBe(true);
  const instructions = container.querySelector('[aria-label="View instructions"]')!;
  const community = container.querySelector('[aria-label="Remove from community"], [aria-label="Post to community"]')!;
  expect(instructions.textContent).toBe('View Instructions');
  expect(order.parentElement).toBe(instructions.parentElement);
  expect(order.parentElement).toBe(community.parentElement);
  expect(order.compareDocumentPosition(instructions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(instructions.compareDocumentPosition(community) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(container.textContent).not.toContain('Not what you were expecting?');
  await act(async () => (manualButtons[0] as HTMLButtonElement).click());
  expect(fetch).toHaveBeenCalledWith('/voxels.xyzrgb');
  expect(container.querySelector('#voxel-edit-prompt')).toBeNull();
  expect(container.querySelector('[aria-label="Exit block editor"]')).not.toBeNull();
  expect(posthog.capture).toHaveBeenCalledWith('generated_model_edit_button_clicked', {
    generation_id: 'g', action: 'enter_editor', is_demo_model: false,
  });
});

it('does not pulse Order while its price is loading', async () => {
  vi.mocked(GetPriceApiService.getPrice).mockImplementation(() => new Promise(() => {}));
  await act(async () => root.render(<MemoryRouter initialEntries={['/generated-model?id=g&exact=1']}><GeneratedModel /></MemoryRouter>));
  const order = container.querySelector('[aria-label="Order my kit"]') as HTMLButtonElement;
  expect(order.disabled).toBe(true);
  expect(order.classList.contains('attention-pulse')).toBe(false);
});
