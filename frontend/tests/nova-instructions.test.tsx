import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { InstructionsPage } from '../src/pages/InstructionsPage';
import { GetGenerationApiService } from '../src/services/getGenerationApi';
import { LdrToMpdApiService } from '../src/services/ldrToMpdApi';
import { NovaToBricksApiService, NovaInstructionPlanError } from '../src/services/novaToBricksApi';
import { LDrawParser } from '../src/utils/ldrawParser';
import { LandingModelWorkspace } from '../src/components/LandingModelWorkspace';
import type { LandingModel } from '../src/hooks/useLandingModel';

vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => ({ user: null, isSupabaseConfigured: false }) }));
vi.mock('../src/components/LandingModelOrdering', () => ({ LandingModelOrdering: () => null }));
vi.mock('../src/components/ThreeLDRViewer', () => ({ ThreeLDRViewer: (props: { currentStepIndex?: number; highlightNewParts?: boolean; preserveOrientation?: boolean; initialCameraState?: {position: {x: number}}; onCameraChange?: (state: unknown) => void }) => <div data-testid={props.currentStepIndex === undefined ? 'model-viewer' : 'instructions-viewer'} data-highlight={String(props.highlightNewParts)} data-preserve-orientation={String(props.preserveOrientation)} data-camera-x={props.initialCameraState?.position.x}>Step {(props.currentStepIndex ?? 0) + 1}<button aria-label="Rotate test model" onClick={() => props.onCameraChange?.({position: {x: 12, y: 10, z: 10}, target: {x: 0, y: 0, z: 0}})} /></div> }));
vi.mock('../src/components/MpdImageRenderer', () => ({ MpdImageRenderer: () => null }));
vi.mock('../src/components/SEO', () => ({ SEO: () => null }));
vi.mock('../src/components/SiteFooter', () => ({ SiteFooter: () => null }));
vi.mock('../src/components/ProfileMenu', () => ({ ProfileMenu: () => null }));
vi.mock('../src/components/NotificationMenu', () => ({ NotificationMenu: () => null }));
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));

const instructions = '0 FILE model.ldr\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n0 STEP\n1 14 0 -24 0 1 0 0 0 1 0 0 0 1 custom.dat\n0 STEP\n0 FILE custom.dat\n0 !LDRAW_ORG Unofficial_Part\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n';

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

it('switches the landing viewer in place, preserves dialogue and step state, and reuses all instruction controls', async () => {
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue(landingModel('nova').generation);
  const get = vi.spyOn(NovaToBricksApiService, 'instructions').mockResolvedValue(instructions);
  vi.spyOn(LdrToMpdApiService, 'convertLdrToMpd').mockResolvedValue({ mpd_content: instructions } as never);
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const createNew = vi.fn();
  const button = (text: string) => Array.from(container.querySelectorAll('button')).find(el => el.textContent === text)!;
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={['/?draft=cottage']}><LocationProbe /><LandingModelWorkspace model={landingModel('nova')} busy={false} onCreateNew={createNew} onSuggest={vi.fn()}><input aria-label="Dialogue" defaultValue="Keep my conversation" /></LandingModelWorkspace></MemoryRouter>));
    const dialogue = container.querySelector('input[aria-label="Dialogue"]');
    const frame = container.querySelector('.landing-model-workspace');
    expect(container.querySelector('.landing-model-heading')?.children[0].textContent).toBe('Create new');
    expect(container.querySelector('.landing-model-heading')?.children[1].textContent).toBe('Garden cottage');
    await act(async () => { button('Show instructions').click(); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(container.querySelector('[data-testid="model-viewer"]')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe('/?draft=cottage');
    expect(container.querySelector('.landing-model-workspace')).toBe(frame);
    expect(button('Previous').disabled).toBe(true);
    expect(container.querySelector('[data-testid="instructions-viewer"]')?.getAttribute('data-highlight')).toBe('true');
    act(() => button('Next').click());
    expect(container.querySelector('[data-testid="instructions-viewer"]')?.textContent).toBe('Step 2');
    expect(button('Next').disabled).toBe(true);
    expect(container.textContent).toContain('Type: custom.dat');
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Rotate test model"]')!.click());
    act(() => button('Previous').click());
    // Returning to the first step resets the camera, as on /instructions.
    expect(container.querySelector('[data-testid="instructions-viewer"]')?.getAttribute('data-camera-x')).toBeNull();
    const stepInput = container.querySelector<HTMLInputElement>('[aria-label="Instruction step"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(stepInput, '2');
      stepInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button('Next').disabled).toBe(true);
    act(() => container.querySelector<HTMLButtonElement>('[title="Show all colors"]')!.click());
    expect(container.querySelector('[data-testid="instructions-viewer"]')?.getAttribute('data-highlight')).toBe('false');
    act(() => button('Show model').click());
    expect(container.querySelector('[data-testid="model-viewer"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="instructions-viewer"]')).toBeNull();
    act(() => button('Show instructions').click());
    expect(get).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="instructions-viewer"]')?.textContent).toBe('Step 2');
    expect(container.querySelector('[data-testid="instructions-viewer"]')?.getAttribute('data-highlight')).toBe('false');
    expect(container.querySelector('input[aria-label="Dialogue"]')).toBe(dialogue);
    expect((dialogue as HTMLInputElement).value).toBe('Keep my conversation');
    act(() => button('Create new').click());
    expect(createNew).toHaveBeenCalledTimes(1);
  } finally { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); }
});

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
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const render = (id: string) => root.render(<MemoryRouter><LandingModelWorkspace model={landingModel(id)} busy={false} onCreateNew={vi.fn()} onSuggest={vi.fn()}><p>Same dialogue</p></LandingModelWorkspace></MemoryRouter>);
  const show = () => Array.from(container.querySelectorAll('button')).find(el => el.textContent === 'Show instructions')!.click();
  try {
    await act(async () => render('old'));
    await act(async () => show());
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Loading building instructions');
    await act(async () => render('new'));
    expect(container.querySelector('[data-testid="model-viewer"]')).not.toBeNull();
    await act(async () => resolveOld(instructions));
    expect(convert).not.toHaveBeenCalled();
    await act(async () => show());
    expect(container.querySelector('[data-testid="instructions-viewer"]')?.textContent).toBe('Step 1');
    expect(container.textContent).toContain('Same dialogue');
  } finally { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); }
});
