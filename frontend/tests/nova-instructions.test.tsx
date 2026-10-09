import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { InstructionsPage } from '../src/pages/InstructionsPage';
import { GetGenerationApiService } from '../src/services/getGenerationApi';
import { LdrToMpdApiService } from '../src/services/ldrToMpdApi';
import { NovaToBricksApiService } from '../src/services/novaToBricksApi';
import { LDrawParser } from '../src/utils/ldrawParser';

vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => ({ user: null, isSupabaseConfigured: false }) }));
vi.mock('../src/components/ThreeLDRViewer', () => ({ ThreeLDRViewer: ({ currentStepIndex }: { currentStepIndex: number }) => <div data-testid="instructions-viewer">Step {currentStepIndex + 1}</div> }));
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

it('shows the repair message and no steps when connection review fails', async () => {
  const { NovaInstructionReviewError } = await import('../src/services/novaToBricksApi');
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue({ generation_id: 'nova', endpoint: 'novaToBricks', status: 'completed' } as never);
  vi.spyOn(NovaToBricksApiService, 'instructions').mockRejectedValue(new NovaInstructionReviewError());
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={['/instructions?id=nova']}><InstructionsPage /></MemoryRouter>));
    expect(container.textContent).toContain('Use Edit with AI to repair disconnected parts and the build order');
    expect(container.querySelector('[data-testid="instructions-viewer"]')).toBeNull();
  } finally { act(() => root.unmount()); container.remove(); }
});
