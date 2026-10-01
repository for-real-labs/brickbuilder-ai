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
import { GetGenerationsByImageApiService } from '../src/services/getGenerationsByImageApi';

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
