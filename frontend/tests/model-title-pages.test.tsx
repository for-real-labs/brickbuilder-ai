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
import { LlmToBricksApiService } from '../src/services/llmToBricksApi';
import { NovaToBricksApiService } from '../src/services/novaToBricksApi';
import { GetGenerationsByImageApiService } from '../src/services/getGenerationsByImageApi';
import { getGeneratedModelPath } from '../src/utils/generationRoutes';
import posthog from 'posthog-js';
import { GenerationEmailApi } from '../src/services/generationEmailApi';

const mocks = vi.hoisted(() => ({ owner: 'owner', user: {id: 'owner'} as {id: string} | null,
  session: null as null | {user: {id: string}}, refresh: vi.fn(), markViewed: vi.fn(), query: vi.fn() }));
vi.mock('../src/contexts/AuthContext', () => ({useAuth: () => ({user: mocks.user, session: mocks.session, userProfile: null, isSupabaseConfigured: true})}));
vi.mock('../src/contexts/GenerationNotificationsContext', () => ({useGenerationNotifications: () => ({refresh: mocks.refresh, markViewed: mocks.markViewed})}));
vi.mock('../src/components/ThreeLDRViewer', () => ({ThreeLDRViewer: ({modelName, onModelLoaded, topLeftOverlay, showModelControls = true}: {modelName: string; onModelLoaded?: () => void; topLeftOverlay?: React.ReactNode; showModelControls?: boolean}) => {
  React.useEffect(() => { onModelLoaded?.(); }, [modelName]);
  return <><div data-testid="viewer" data-controls={showModelControls}>{modelName}</div>{topLeftOverlay}</>;
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
  mocks.owner = 'owner';
  mocks.user = {id: 'owner'};
  mocks.session = null;
  mocks.query.mockImplementation(async () => ({data: {user_id: mocks.owner, is_community: true, preview_image_url: '/preview.png'}, error: null}));
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue({generation_id: 'g', status: 'completed', name: 'Sunny Dachshund', prompt: 'please create a dachshund in sunglasses, with lots of details', ldr_content: 'ldr'} as never);
  vi.spyOn(LdrToMpdApiService, 'convertLdrToMpd').mockResolvedValue({mpd_content: 'mpd'} as never);
  vi.spyOn(GetPriceApiService, 'getPrice').mockRejectedValue(new Error('No estimate'));
  vi.spyOn(GenerationNotificationsApi, 'latestEdit').mockResolvedValue({generation_id: null});
  vi.spyOn(GenerationEmailApi, 'status').mockResolvedValue({subscribed: false, email: null});
  vi.spyOn(GenerationEmailApi, 'subscribe').mockResolvedValue({subscribed: true, email: 'builder@example.com'});
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

it('downloads the editable agent source archive for a completed Nova model and cleans up the temporary URL', async () => {
  vi.mocked(GetGenerationApiService.getGeneration).mockResolvedValue({ generation_id: 'g', endpoint: 'novaToBricks', status: 'completed', name: 'Spaceport', prompt: 'spaceport', ldr_content: 'ldr' } as never);
  const archive = new Blob(['zip'], { type: 'application/zip' });
  const download = vi.spyOn(NovaToBricksApiService, 'downloadSource').mockResolvedValue(archive);
  const create = vi.fn().mockReturnValue('blob:archive');
  const revoke = vi.fn();
  vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await act(async () => root.render(<MemoryRouter initialEntries={['/generated-model?id=g&exact=1']}><GeneratedModel /></MemoryRouter>));
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Export model"]')!.click());
  const button = Array.from(container.querySelectorAll('button')).find(button => button.textContent === ' Download agent source' || button.textContent?.trim() === 'Download agent source')!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
  expect(download).toHaveBeenCalledWith('g');
  expect(create).toHaveBeenCalledWith(archive);
  expect(click).toHaveBeenCalledOnce();
  expect(revoke).toHaveBeenCalledWith('blob:archive');
  expect(posthog.capture).toHaveBeenCalledWith('generated_model_nova_source_download_clicked', { generation_id: 'g' });
});

it('shows an owner permission error when the agent source cannot be downloaded', async () => {
  vi.mocked(GetGenerationApiService.getGeneration).mockResolvedValue({ generation_id: 'g', endpoint: 'novaToBricks', status: 'completed', name: 'Spaceport', prompt: 'spaceport', ldr_content: 'ldr' } as never);
  vi.spyOn(NovaToBricksApiService, 'downloadSource').mockRejectedValue(new Error('Only the owner can download this agent source.'));
  await act(async () => root.render(<MemoryRouter initialEntries={['/generated-model?id=g&exact=1']}><GeneratedModel /></MemoryRouter>));
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Export model"]')!.click());
  await act(async () => Array.from(container.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Download agent source')!.click());
  expect(container.textContent).toContain('Only the owner can download this agent source.');
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
  expect(container.querySelector('.checkout-summary-heading')?.textContent).toBe('My Sunny Dog');
  expect(container.querySelector('[data-testid="viewer"]')?.textContent).toBe('My Sunny Dog');
});

it('shows the saved server title on /order even when navigation contains an old name', async () => {
  await act(async () => root.render(<MemoryRouter initialEntries={[{pathname:'/order', state: {generation_id:'g', name:'Old Title'}}]}><OrderKit /></MemoryRouter>));
  expect(container.querySelector('.checkout-summary-heading')?.textContent).toBe('Sunny Dachshund');
  expect(LdrToMpdApiService.convertLdrToMpd).toHaveBeenCalledWith('ldr', 'Sunny Dachshund', 'token');
});

it.each(['basic_bricks', 'all_parts'])('shows a concise build warning only for %s checkout', async mode => {
  vi.mocked(GetGenerationApiService.getGeneration).mockResolvedValue({ generation_id: 'g', mode, status: 'completed', name: 'Pirate ship', ldr_content: 'ldr' } as never);
  await act(async () => root.render(<MemoryRouter initialEntries={[{ pathname: '/order', state: { generation_id: 'g' } }]}><OrderKit /></MemoryRouter>));
  const steps = Array.from(container.querySelectorAll('a')).find(link => link.textContent === 'Check the steps');
  if (mode === 'all_parts') {
    expect(steps?.getAttribute('href')).toBe('/instructions?id=g');
    expect(steps?.parentElement?.textContent).toContain('Some pieces may not fit.');
    expect(Array.from(container.querySelectorAll('a')).find(link => link.textContent === 'Basic bricks')?.getAttribute('href')).toBe('/');
  } else expect(steps).toBeUndefined();
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


it('continues Nova AI edits while keeping the completed model, instructions, and progress overlay usable', async () => {
  const original = { generation_id: 'g', endpoint: 'novaToBricks', status: 'completed', name: 'Garden cottage', prompt: 'cottage', ldr_content: 'ldr' };
  vi.mocked(GetGenerationApiService.getGeneration).mockImplementation(async id => (id === 'g' ? original : {
    generation_id: 'edit', endpoint: 'novaToBricks', status: 'processing', previous_completed_generation_id: 'g', version: 2,
  }) as never);
  let finish!: (value: never) => void;
  const polling = new Promise<never>(resolve => { finish = resolve; });
  vi.spyOn(GetGenerationApiService, 'pollUntilComplete').mockReturnValue(polling);
  const novaEdit = vi.spyOn(NovaToBricksApiService, 'edit').mockResolvedValue({ generation_id: 'edit', message: 'Started' });
  const llm = vi.spyOn(LlmToBricksApiService, 'generate');
  vi.spyOn(LlmToBricksApiService, 'watchOutput').mockImplementation(async (_id, output) => {
    output({ text: 'Nova is refining the roof', status: 'processing' });
    return true;
  });
  await act(async () => root.render(<MemoryRouter initialEntries={['/generated-model?id=g&exact=1']}><GeneratedModel /></MemoryRouter>));
  const input = container.querySelector('#voxel-edit-prompt') as HTMLTextAreaElement;
  expect(input).not.toBeNull();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Make the roof red');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(novaEdit).toHaveBeenCalledWith('g', 'Make the roof red', 'token');
  expect(llm).not.toHaveBeenCalled();
  const viewer = container.querySelector('[data-testid="viewer"]')!;
  expect(viewer.textContent).toContain('Garden cottage');
  expect(viewer.closest('figure')?.textContent).toContain('This can take up to 30 min. You can close this window safely.');
  expect(viewer.closest('figure')?.textContent).toContain('Refining the roof');
  expect(container.querySelector<HTMLButtonElement>('[aria-label="View instructions"]')!.disabled).toBe(false);
  expect(container.querySelector('[aria-label="Manually edit model"]')).toBeNull();
  await act(async () => {
    finish({ ...original, generation_id: 'edit', name: 'Red-roof cottage' } as never);
    await polling;
  });
  expect(container.querySelector('[data-testid="viewer"]')?.textContent).toBe('Red-roof cottage');
  expect(container.textContent).not.toContain('This can take up to 30 min.');
});

const pendingDashboardEdit = {
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
    await act(async () => root.render(<MemoryRouter><GenerationCard g={{...pendingDashboardEdit, status}} onView={onView} /></MemoryRouter>));
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
    return <GenerationCard g={pendingDashboardEdit} onView={(id, exact) => navigate(getGeneratedModelPath(id, exact))} />;
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
    ...pendingDashboardEdit, version: 1, previous_completed_generation_id: null, previous_completed_preview_image_url: null,
  }} onView={onView} /></MemoryRouter>));
  const preview = container.querySelector('[aria-label="View model preview"]') as HTMLButtonElement;
  expect(preview.disabled).toBe(true);
  expect(Array.from(container.querySelectorAll('button')).some(button => button.textContent?.includes('View Model'))).toBe(false);
  act(() => preview.click());
  expect(onView).not.toHaveBeenCalled();
});

it('uses the new revision preview and regular navigation once the edit completes', async () => {
  const onView = vi.fn();
  await act(async () => root.render(<MemoryRouter><GenerationCard g={{...pendingDashboardEdit, status: 'completed'}} onView={onView} /></MemoryRouter>));
  expect(container.querySelector('img')?.getAttribute('src')).toBe('/unfinished.png');
  expect(container.querySelector('[role="status"]')).toBeNull();
  act(() => (container.querySelector('[aria-label="View model preview"]') as HTMLButtonElement).click());
  expect(onView).toHaveBeenCalledWith('pending', false);
});

it('places editing and ordering beside the preview and preserves the block editor', async () => {
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
  expect(order.disabled).toBe(true);
  expect(order.closest('aside')).toBe(editForm.closest('aside'));
  expect(container.textContent).toContain('Price unavailable right now.');
  const instructions = container.querySelector('[aria-label="View instructions"]')!;
  const community = container.querySelector('[aria-label="Remove from community"], [aria-label="Post to community"]')!;
  expect(instructions.textContent).toBe('View Instructions');
  expect(instructions.closest('.model-workspace-secondary')).not.toBeNull();
  expect(community.closest('.model-workspace-secondary')).not.toBeNull();
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

it('disables both purchase controls while the price is loading', async () => {
  vi.mocked(GetPriceApiService.getPrice).mockImplementation(() => new Promise(() => {}));
  await act(async () => root.render(<MemoryRouter initialEntries={['/generated-model?id=g&exact=1']}><GeneratedModel /></MemoryRouter>));
  const order = container.querySelector('[aria-label="Order my kit"]') as HTMLButtonElement;
  expect(order.disabled).toBe(true);
  expect((container.querySelector('[aria-label="Order this model"]') as HTMLButtonElement).disabled).toBe(true);
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

it.each([true, false])('offers the shared email flow on an initial generation, signed in: %s', async signedIn => {
  mockPendingEdit();
  mocks.session = signedIn ? {user: {id: 'owner'}} : null;
  vi.mocked(GetGenerationApiService.getGeneration).mockResolvedValue({
    generation_id: 'new-build', status: 'processing', endpoint: 'llmToBricks', version: 1,
  } as never);
  vi.spyOn(GetGenerationApiService, 'pollUntilComplete').mockImplementation(() => new Promise(() => {}));
  await act(async () => root.render(<MemoryRouter initialEntries={['/generated-model?id=new-build']}><GeneratedModel /></MemoryRouter>));
  const notify = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Get notified')!;
  expect(notify).toBeTruthy();
  expect(GenerationEmailApi.status).toHaveBeenCalledWith('new-build', expect.any(AbortSignal));
  await act(async () => notify.click());
  const modal = document.querySelector('[role="dialog"]')!;
  if (signedIn) {
    expect(GenerationEmailApi.subscribe).toHaveBeenCalledWith('new-build', undefined);
    expect(modal.textContent).toContain('builder@example.com');
  } else {
    expect(modal.querySelector('input[type="email"]')).not.toBeNull();
    expect(GenerationEmailApi.subscribe).not.toHaveBeenCalled();
  }
});

it('restores the edit notification and its recipient when returning to the model page', async () => {
  mockPendingEdit();
  vi.mocked(GenerationEmailApi.status).mockResolvedValue({subscribed: true, email: 'edit-recipient@example.com'});
  vi.spyOn(GetGenerationApiService, 'pollUntilComplete').mockImplementation(() => new Promise(() => {}));
  await act(async () => root.render(<MemoryRouter initialEntries={['/generated-model?id=g']}><GeneratedModel /></MemoryRouter>));
  expect(GenerationEmailApi.status).toHaveBeenCalledWith('g', expect.any(AbortSignal));
  expect(GenerationEmailApi.status).not.toHaveBeenCalledWith('old', expect.anything());
  const notify = Array.from(container.querySelectorAll('figure button')).find(button => button.textContent === 'We’ll email you')!;
  act(() => notify.click());
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('edit-recipient@example.com');
  expect(container.textContent).toContain('Emailing edit-recipient@example.com');
  expect(GenerationEmailApi.subscribe).not.toHaveBeenCalled();
});

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
  expect(modelButton('Manually edit model').disabled).toBe(true);
  expect(modelButton('Manually edit model').textContent).toBe('Manually Edit');
  expect(modelButton('Remove from community').disabled).toBe(true);
  expect(modelButton('Order my kit').disabled).toBe(true);
  expect((container.querySelector('#voxel-edit-prompt') as HTMLTextAreaElement).disabled).toBe(true);
  expect(modelButton('Order this model').disabled).toBe(true);
  expect(modelButton('View instructions').disabled).toBe(false);
  expect(modelButton('Export model').disabled).toBe(false);
  expect(modelButton('Like community model').disabled).toBe(false);
  expect(container.querySelector('aside')?.getAttribute('style') || '').not.toContain('opacity: 0');
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
  expect(modelButton('Manually edit model').disabled).toBe(true);
  expect(modelButton('Order my kit').disabled).toBe(true);
  await act(async () => startEdit({generation_id: 'g'}));
  expect(container.querySelector('[data-testid="viewer"]')).toBe(viewer);
  expect(container.textContent).toContain('Shrinking the Pepsi can');
  expect(container.textContent).not.toContain('Continue browsing');
  expect(container.textContent).toContain('Get notified');
  const notify = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Get notified')!;
  act(() => notify.click());
  act(() => {
    const input = document.querySelector('[role="dialog"] input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'builder@example.com');
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await act(async () => document.querySelector('[role="dialog"] form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
  expect(GenerationEmailApi.subscribe).toHaveBeenCalledWith('g', 'builder@example.com');
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('builder@example.com');
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
  expect(modelButton('Manually edit model').disabled).toBe(false);
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
  expect(modelButton('Manually edit model').disabled).toBe(false);
  expect(modelButton('Order my kit').disabled).toBe(false);
});

it('keeps the source model available and unlocks controls after an edit fails', async () => {
  mockPendingEdit();
  vi.spyOn(GetGenerationApiService, 'pollUntilComplete').mockRejectedValue(new Error('Edit interrupted'));
  await act(async () => root.render(<MemoryRouter initialEntries={['/generated-model?id=g&exact=1']}><GeneratedModel /></MemoryRouter>));
  expect(container.querySelector('h1')?.textContent).toBe('Pepsi Can');
  expect(container.textContent).toContain('Edit interrupted');
  expect(container.textContent).not.toContain('Failed to Load Model');
  expect(modelButton('Manually edit model').disabled).toBe(false);
  expect(modelButton('Order my kit').disabled).toBe(false);
});

it('opens the last completed model when returning to a failed edit', async () => {
  mockPendingEdit();
  vi.mocked(GetGenerationApiService.getGeneration).mockImplementation(async id => (
    id === 'old' ? {...completedEditSource, endpoint: 'novaToBricks'} : {
      ...pendingEdit, endpoint: 'novaToBricks', status: 'failed',
      error_message: 'Nova session or artifact is unavailable. Check the runtime data volume.',
    }
  ) as never);
  await act(async () => root.render(<MemoryRouter initialEntries={['/generated-model?id=g']}><GeneratedModel /></MemoryRouter>));
  expect(container.querySelector('h1')?.textContent).toBe('Pepsi Can');
  expect(container.textContent).toContain('Your saved model is intact; try your edit again.');
  expect(container.textContent).not.toContain('Failed to Load Model');
  expect((container.querySelector('#voxel-edit-prompt') as HTMLTextAreaElement).disabled).toBe(false);
  const edit = vi.spyOn(NovaToBricksApiService, 'edit').mockRejectedValue(new Error('Test request stopped'));
  act(() => {
    const input = container.querySelector('#voxel-edit-prompt')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Try a taller roof');
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await act(async () => container.querySelector('#voxel-edit-prompt')!.closest('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
  expect(edit).toHaveBeenCalledWith('old', 'Try a taller roof', 'token');
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
  expect(modelButton('Manually edit model').disabled).toBe(true);
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

it('hides model controls and keeps the resolved order title visible', async () => {
  await act(async () => root.render(<MemoryRouter initialEntries={[{pathname:'/order', state:{generation_id:'g'}}]}><OrderKit /></MemoryRouter>));
  expect(container.querySelector('[data-testid="viewer"]')?.getAttribute('data-controls')).toBe('false');
  expect(container.querySelector('.checkout-summary h2')?.textContent).toBe('Sunny Dachshund');
  expect(container.textContent).not.toContain('Regular size kit');
});


it.each(['Order my kit', 'Order this model'])('opens checkout for the displayed model from %s with the same quote', async label => {
  const quote = {generation_id: 'g', total_price: 44.77, total_parts: 370, total_weight: .5263, currency: 'USD', parts_breakdown: []};
  vi.mocked(GetPriceApiService.getPrice).mockResolvedValue(quote as never);
  const Location = () => { const location = useLocation(); return <output>{JSON.stringify({path: location.pathname, state: location.state})}</output>; };
  await act(async () => root.render(<MemoryRouter initialEntries={['/generated-model?id=g&exact=1']}><GeneratedModel /><Location /></MemoryRouter>));
  expect(container.querySelector('.model-order-total')?.textContent).toBe('$22.39');
  await act(async () => modelButton(label).click());
  const result = JSON.parse(container.querySelector('output')!.textContent!);
  expect(result.path).toBe('/order');
  expect(result.state.generation_id).toBe('g');
  expect(result.state.name).toBe('Sunny Dachshund');
  expect(result.state.priceData).toEqual(quote);
  expect(posthog.capture).toHaveBeenCalledWith('generated_model_order_clicked', {
    generation_id: 'g', is_demo_model: false, source: label === 'Order my kit' ? 'card' : 'mobile_bar',
  });
});

it('shows the saved generation duration on the dashboard card', async () => {
  await act(async () => root.render(<MemoryRouter><GenerationCard g={{
    id: 'timed', user_id: 'owner', user_type: 'authenticated', prompt: 'Fish', detail_level: 40,
    endpoint: 'novaToBricks', created_at: '2026-10-01', status: 'completed', generation_duration_seconds: 125,
  }} onView={vi.fn()} /></MemoryRouter>));
  expect(container.textContent).toContain('Generation time: 2m 5s');
});

it('loads the saved edit example from the generated model response', async () => {
  vi.mocked(GetGenerationApiService.getGeneration).mockResolvedValue({generation_id: 'g', status: 'completed',
    endpoint: 'novaToBricks', name: 'Fish', prompt: 'image reference', ldr_content: 'ldr',
    example_edit_prompt: 'Make the fins blue and add a longer tail'} as never);
  await act(async () => root.render(<MemoryRouter initialEntries={['/generated-model?id=g&exact=1']}><GeneratedModel /></MemoryRouter>));
  expect(container.querySelector('textarea')?.placeholder).toBe('e.g. Make the fins blue and add a longer tail');
});
