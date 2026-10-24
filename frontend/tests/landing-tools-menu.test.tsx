vi.mock('../src/contexts/BillingContext', () => ({ useBilling: () => ({ featureAccess: 'allowed', getFeatureAccess: () => 'allowed', requireFeature: () => true, enabled: false, openUpgrade: vi.fn(), retryAccess: vi.fn() }) }));
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { LandingToolsMenu, type LandingToolsHandle } from '../src/components/LandingToolsMenu';
import * as exports from '../src/utils/modelExport';
import type { LandingModel } from '../src/hooks/useLandingModel';
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('../src/components/PetCompanion', () => ({ PetSwitchButton: () => <button>Build Buddy</button> }));
vi.mock('../src/components/FeedbackWidget', () => ({ FeedbackWidget: ({ open }: { open: boolean }) => open ? <div role="dialog">Feedback form</div> : null }));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const button = (label: string) => [...host.querySelectorAll('button')].find(node => node.textContent === label)!;
const model = { content: 'model content', generation: { generation_id: 'castle', name: 'Castle' } } as LandingModel;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const mount = (selected: LandingModel | null = model, busy = false) => act(() => root.render(<MemoryRouter><LandingToolsMenu page="/" model={selected} busy={busy}
  generationSettings={{ open: false, controls: 'settings', onOpen: vi.fn() }} /></MemoryRouter>));

it('puts Import first and Export second, separates groups, and keeps Community/GitHub together above Feedback/Support', () => {
  mount(); act(() => button('Tools').click());
  const rows = [...host.querySelectorAll('ul[aria-label="Tools"] > li')];
  expect(rows.map(row => row.textContent)).toEqual(['Import', 'Export', '', 'Generation settings', '', 'Image to LEGO', 'GLB to LEGO', 'OBJ to LEGO', '', 'Build Buddy', '', 'Community', 'GitHub', '', 'Feedback', 'Support']);
  expect(host.querySelectorAll('[role="separator"]')).toHaveLength(5);
  expect(button('Export').querySelector('.lucide-download')).not.toBeNull();
  act(() => button('Import').click());
  expect([...host.querySelectorAll('[aria-label="Import options"] a')].map(node => node.getAttribute('href'))).toEqual(['/use-ai-to-edit-ldraw?format=ldraw', '/use-ai-to-edit-ldraw?format=io']);
  act(() => button('Export').click());
  expect(host.querySelector('[aria-label="Import options"]')).toBeNull();
  expect(button('Download parts list CSV').closest('li')?.className).toContain('border-t');
});

it('omits the settings section and its divider when settings are unavailable', () => {
  act(() => root.render(<MemoryRouter><LandingToolsMenu page="/use-ai-to-edit-ldraw" /></MemoryRouter>));
  act(() => button('Tools').click());
  const rows = [...host.querySelectorAll('ul[aria-label="Tools"] > li')];
  expect(rows.slice(0, 4).map(row => row.textContent)).toEqual(['Import', 'Export', '', 'Image to LEGO']);
  expect(rows.some(row => row.textContent === 'Generation settings')).toBe(false);
  expect(host.querySelectorAll('[role="separator"]')).toHaveLength(4);
});

it.each([['ldraw', 'Download LDraw'], ['io', 'Download IO'], ['csv', 'Download parts list CSV'], ['xml', 'Download parts list XML']] as const)('downloads %s from the displayed model with analytics', (format, label) => {
  const download = vi.spyOn(exports, 'downloadModel').mockImplementation(() => {});
  mount(); act(() => button('Tools').click()); act(() => button('Export').click()); act(() => button(label).click());
  expect(download).toHaveBeenCalledWith(model.content, 'Castle', format);
  expect(posthog.capture).toHaveBeenCalledWith('landing_model_export_clicked', expect.objectContaining({ generation_id: 'castle', format }));
  expect(host.querySelector('ul[aria-label="Tools"]')).toBeNull();
});

it('disables downloads without a finished model and shows recoverable export errors', () => {
  mount(null); act(() => button('Tools').click()); act(() => button('Export').click());
  expect(button('Download LDraw').disabled).toBe(true);
  mount(model, true); act(() => button('Export').click());
  expect(button('Download IO').disabled).toBe(true);
  mount(model, false);
  vi.spyOn(exports, 'downloadModel').mockImplementation(() => { throw new Error('Try the CSV instead.'); });
  act(() => button('Download parts list XML').click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Try the CSV instead.');
  act(() => button('Download parts list XML').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.activeElement).toBe(button('Tools'));
});

vi.mock('../src/components/SupportDialog', () => ({ SupportDialog: ({ open }: { open: boolean }) => open ? <div role="dialog">Support form</div> : null }));
const pet = vi.hoisted(() => ({ openPicker: vi.fn() }));
vi.mock('../src/contexts/PetContext', () => ({ usePet: () => pet }));
const toolRef = React.createRef<LandingToolsHandle>();
const settings = vi.fn();
function Location() { const loc = useLocation(); return <output>{loc.pathname}{loc.search}</output>; }
const mountBuddy = (selected: LandingModel | null = model, busy = false) => act(() => root.render(<MemoryRouter><Location /><LandingToolsMenu ref={toolRef} page="/" model={selected} busy={busy} generationSettings={{ open: false, controls: 'settings', onOpen: settings }} /></MemoryRouter>));
function run(action: Parameters<LandingToolsHandle['runTool']>[0], id?: string) {
  let reply = ''; act(() => { reply = toolRef.current!.runTool(action, id); }); return reply;
}

it.each(['ldraw', 'io', 'csv', 'xml'] as const)('pet downloads %s exactly once from the expected model', format => {
  const download = vi.spyOn(exports, 'downloadModel').mockImplementation(() => {});
  mountBuddy();
  expect(run(`export_${format}`, 'castle')).toBe('Starting your download.');
  expect(download).toHaveBeenCalledExactlyOnceWith(model.content, 'Castle', format);
});
it('refuses missing, changing and busy models and reports download failure', () => {
  const download = vi.spyOn(exports, 'downloadModel').mockImplementation(() => { throw new Error('Unable to export this model.'); });
  mountBuddy(null); expect(run('export_csv')).toContain('Open or create');
  mountBuddy(); expect(run('export_csv', 'old-model')).toContain('selected model changed');
  mountBuddy(model, true); expect(run('export_csv', 'castle')).toContain('still updating');
  expect(download).not.toHaveBeenCalled();
  mountBuddy(); expect(run('export_csv', 'castle')).toBe('Unable to export this model.');
});
it.each(['export', 'import'] as const)('pet opens and focuses the %s format choices', action => {
  mountBuddy(); run(action);
  expect(host.querySelector(`ul[aria-label="${action === 'export' ? 'Export' : 'Import'} options"]`)).not.toBeNull();
  expect(document.activeElement?.textContent).toBe(action === 'export' ? 'Download LDraw' : 'Import LDraw');
});
it.each([
 ['import_ldraw', '/use-ai-to-edit-ldraw?format=ldraw'], ['import_io', '/use-ai-to-edit-ldraw?format=io'],
 ['convert_image', '/image-to-lego'], ['convert_glb', '/glb-to-lego'], ['convert_obj', '/obj-to-lego'], ['community', '/community'],
] as const)('pet opens the fixed %s destination', (action, route) => {
 mountBuddy(); run(action); expect(host.querySelector('output')?.textContent).toBe(route);
});
it('pet opens generation and buddy settings', () => {
 mountBuddy(); run('generation_settings'); expect(settings).toHaveBeenCalledWith(button('Tools'));
 run('buddy_settings'); expect(pet.openPicker).toHaveBeenCalledWith('buddy_chat', button('Tools'));
});
it.each(['feedback', 'support'] as const)('pet opens %s for user submission', action => {
 const fetch = vi.spyOn(globalThis, 'fetch'); mountBuddy();
 expect(run(action)).toContain('press Send'); expect(host.querySelector('[role="dialog"]')?.textContent).toContain(action === 'support' ? 'Support' : 'Feedback');
 expect(fetch).not.toHaveBeenCalled();
});
