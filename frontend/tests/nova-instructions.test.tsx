import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { LandingModelWorkspace } from '../src/components/LandingModelWorkspace';
import { InstructionsPage } from '../src/pages/InstructionsPage';
import { GetGenerationApiService } from '../src/services/getGenerationApi';
import { LdrToMpdApiService } from '../src/services/ldrToMpdApi';
import { NovaToBricksApiService, NovaInstructionPlanError } from '../src/services/novaToBricksApi';
import { LDrawParser } from '../src/utils/ldrawParser';
import type { LandingModel } from '../src/hooks/useLandingModel';
import { readFileSync } from 'node:fs';

const authState = vi.hoisted(() => ({ configured: false }));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => ({ user: null, isSupabaseConfigured: authState.configured }) }));
vi.mock('../src/contexts/GenerationNotificationsContext', () => ({ useGenerationNotifications: () => ({ markViewed: vi.fn() }) }));
vi.mock('../src/components/LandingModelOrdering', () => ({ LandingModelOrdering: () => null }));
vi.mock('../src/components/ThreeLDRViewer', () => ({ ThreeLDRViewer: (props: { currentStepIndex?: number; highlightNewParts?: boolean; preserveOrientation?: boolean; initialCameraState?: {position: {x: number}}; onCameraChange?: (state: unknown) => void }) => <div data-testid={props.currentStepIndex === undefined ? 'model-viewer' : 'instructions-viewer'} data-highlight={String(props.highlightNewParts)} data-preserve-orientation={String(props.preserveOrientation)} data-camera-x={props.initialCameraState?.position.x}>Step {(props.currentStepIndex ?? 0) + 1}<button aria-label="Rotate test model" onClick={() => props.onCameraChange?.({position: {x: 12, y: 10, z: 10}, target: {x: 0, y: 0, z: 0}})} /></div> }));
vi.mock('../src/components/MpdImageRenderer', () => ({ MpdImageRenderer: () => null }));
vi.mock('../src/components/SEO', () => ({ SEO: () => null }));
vi.mock('../src/components/SiteFooter', () => ({ SiteFooter: () => null }));
vi.mock('../src/components/ProfileMenu', () => ({ ProfileMenu: () => null }));
vi.mock('../src/components/NotificationMenu', () => ({ NotificationMenu: () => <button aria-label="Notifications" /> }));
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));

const instructions = '0 FILE model.ldr\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n0 STEP\n1 14 0 -24 0 1 0 0 0 1 0 0 0 1 custom.dat\n0 STEP\n0 FILE custom.dat\n0 !LDRAW_ORG Unofficial_Part\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n';

it('does not show a notification bell in the guest instructions header', async () => {
  authState.configured = true;
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue({ generation_id: 'nova', endpoint: 'novaToBricks', status: 'completed', name: 'Garden cottage', prompt: 'cottage', ldr_content: 'flat preview' } as never);
  vi.spyOn(NovaToBricksApiService, 'instructions').mockResolvedValue(instructions);
  vi.spyOn(LdrToMpdApiService, 'convertLdrToMpd').mockResolvedValue({ mpd_content: instructions } as never);
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={['/instructions?id=nova']}><InstructionsPage /></MemoryRouter>));
    expect(container.querySelector('header [aria-label="Notifications"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
    authState.configured = false;
  }
});

it('loads Nova construction steps into the existing viewer and supports Previous/Next without playback', async () => {
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue({ generation_id: 'nova', endpoint: 'novaToBricks', status: 'completed', name: 'Garden cottage', prompt: 'cottage', ldr_content: 'flat preview' } as never);
  const get = vi.spyOn(NovaToBricksApiService, 'instructions').mockResolvedValue(instructions);
  const pack = vi.spyOn(LdrToMpdApiService, 'convertLdrToMpd').mockResolvedValue({ mpd_content: instructions } as never);
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={['/instructions?id=nova']}><InstructionsPage /></MemoryRouter>));
    expect(get).toHaveBeenCalledWith('nova');
    expect(pack).toHaveBeenCalledWith(instructions, 'cottage', undefined);
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('[data-testid="instructions-viewer"]')?.textContent).toBe('Step 1');
    const next = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('Next'))!;
    act(() => next.click());
    expect(container.querySelector('[data-testid="instructions-viewer"]')?.textContent).toBe('Step 2');
    expect(container.textContent).toContain('custom.dat');
    const previous = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('Previous'))!;
    act(() => previous.click());
    expect(container.querySelector('[data-testid="instructions-viewer"]')?.textContent).toBe('Step 1');
  } finally { act(() => root.unmount()); container.remove(); }
});

it('does not count embedded part geometry as extra building placements or steps', () => {
  const model = LDrawParser.parseLDRContent(instructions);
  expect(model.parts).toHaveLength(2);
  expect(model.steps).toHaveLength(2);
  expect(model.steps[1].parts[0].filename).toBe('custom.dat');
  expect(LDrawParser.embeddedDefinitions(instructions)).toContain('0 FILE custom.dat');
});


it('shows repair guidance when connected instruction planning fails', async () => {
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue({ endpoint: 'novaToBricks', status: 'completed' } as never);
  vi.spyOn(NovaToBricksApiService, 'instructions').mockRejectedValue(new NovaInstructionPlanError());
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={['/instructions?id=nova']}><InstructionsPage /></MemoryRouter>));
    expect(container.textContent).toContain('Edit the model to repair those connections');
    expect(container.querySelector('[data-testid="instructions-viewer"]')).toBeNull();
  } finally { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); }
});


function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}
const landingModel = (id: string): LandingModel => ({
  generation: { generation_id: id, endpoint: 'novaToBricks', status: 'completed', name: 'Garden cottage', prompt: 'cottage' },
  content: 'flat preview',
} as LandingModel);

it('loads a linked instruction step and keeps standalone step links working', async () => {
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue(landingModel('nova').generation);
  vi.spyOn(NovaToBricksApiService, 'instructions').mockResolvedValue(instructions);
  vi.spyOn(LdrToMpdApiService, 'convertLdrToMpd').mockResolvedValue({ mpd_content: instructions } as never);
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={['/instructions?id=nova&step=2']}><LocationProbe /><InstructionsPage /></MemoryRouter>));
    expect(container.querySelector('[data-testid="instructions-viewer"]')?.textContent).toBe('Step 2');
    act(() => Array.from(container.querySelectorAll('button')).find(el => el.textContent?.trim() === 'Previous')!.click());
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe('/instructions?id=nova&step=1');
  } finally { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); }
});

it('lets an embedded instruction load recover without leaving the dialogue', async () => {
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue(landingModel('nova').generation);
  const load = vi.spyOn(NovaToBricksApiService, 'instructions').mockRejectedValueOnce(new NovaInstructionPlanError()).mockResolvedValueOnce(instructions);
  vi.spyOn(LdrToMpdApiService, 'convertLdrToMpd').mockResolvedValue({ mpd_content: instructions } as never);
  const { InstructionsViewer } = await import('../src/pages/InstructionsPage');
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter><InstructionsViewer generationId="nova" embedded /></MemoryRouter>));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Edit the model to repair those connections');
    await act(async () => container.querySelector<HTMLButtonElement>('.instructions-retry')!.click());
    expect(load).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="instructions-viewer"]')?.textContent).toBe('Step 1');
  } finally { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); }
});

it('ignores instruction results from a model that has been replaced', async () => {
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockImplementation(async id => landingModel(id).generation);
  let resolveOld!: (value: string) => void;
  vi.spyOn(NovaToBricksApiService, 'instructions').mockImplementation(id => id === 'old' ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve(instructions));
  const convert = vi.spyOn(LdrToMpdApiService, 'convertLdrToMpd').mockResolvedValue({ mpd_content: instructions } as never);
  const { InstructionsViewer } = await import('../src/pages/InstructionsPage');
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const render = (id: string) => root.render(<MemoryRouter><InstructionsViewer generationId={id} embedded /></MemoryRouter>);
  try {
    await act(async () => render('old'));
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Loading building instructions');
    await act(async () => render('new'));
    await act(async () => resolveOld(instructions));
    expect(convert).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="instructions-viewer"]')?.textContent).toBe('Step 1');
  } finally { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); }
});


it('opens instructions from the landing footer and preserves steps, colors and dialogue when toggling views', async () => {
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue(landingModel('nova').generation);
  const get = vi.spyOn(NovaToBricksApiService, 'instructions').mockResolvedValue(instructions);
  vi.spyOn(LdrToMpdApiService, 'convertLdrToMpd').mockResolvedValue({ mpd_content: instructions } as never);
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const styles = document.createElement('style');
  styles.textContent = readFileSync('src/pages/InstructionsViewer.css', 'utf8');
  document.head.append(styles);
  const button = (text: string) => Array.from(container.querySelectorAll('button')).find(el => el.textContent?.trim() === text)!;
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={['/?id=nova&exact=1']}><LocationProbe />
      <LandingModelWorkspace model={landingModel('nova')} busy={false}><input aria-label="Dialogue" defaultValue="Keep my conversation" /></LandingModelWorkspace>
    </MemoryRouter>));
    const dialogue = container.querySelector('input[aria-label="Dialogue"]');
    const toggle = container.querySelector<HTMLButtonElement>('.landing-instructions-toggle')!;
    await act(async () => { toggle.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(container.querySelector('[data-testid="instructions-viewer"]')?.textContent).toBe('Step 1');
    expect(container.querySelector('.landing-model-heading')).toBeNull();
    const colors = container.querySelector<HTMLButtonElement>('.instructions-colors-toggle')!;
    expect(colors.textContent).toBe('Show colors');
    expect(colors.getAttribute('aria-pressed')).toBe('false');
    expect(getComputedStyle(colors).top).toBe('64px');
    expect(getComputedStyle(colors).minHeight).toBe('44px');
    act(() => button('Next').click());
    expect(container.querySelector('[data-testid="instructions-viewer"]')?.textContent).toBe('Step 2');
    act(() => colors.click());
    expect(colors.textContent).toBe('Hide colors');
    expect(colors.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-testid="instructions-viewer"]')?.getAttribute('data-highlight')).toBe('false');
    act(() => toggle.click());
    expect(container.querySelector('[data-testid="model-viewer"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="instructions-viewer"]')).toBeNull();
    act(() => toggle.click());
    expect(get).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="instructions-viewer"]')?.textContent).toBe('Step 2');
    expect(container.querySelector('[data-testid="instructions-viewer"]')?.getAttribute('data-highlight')).toBe('false');
    expect(container.querySelector('input[aria-label="Dialogue"]')).toBe(dialogue);
    expect((dialogue as HTMLInputElement).value).toBe('Keep my conversation');
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe('/?id=nova&exact=1');
    expect(container.querySelector('iframe')).toBeNull();
  } finally { act(() => root.unmount()); container.remove(); styles.remove(); vi.restoreAllMocks(); }
});
