import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { LandingToolsMenu } from '../src/components/LandingToolsMenu';
import * as exports from '../src/utils/modelExport';
import type { LandingModel } from '../src/hooks/useLandingModel';
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('../src/components/PetCompanion', () => ({ PetSwitchButton: () => <button>Build Buddy</button> }));
vi.mock('../src/components/FeedbackWidget', () => ({ FeedbackWidget: () => null }));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const button = (label: string) => [...host.querySelectorAll('button')].find(node => node.textContent === label)!;
const model = { content: 'model content', generation: { generation_id: 'castle', name: 'Castle' } } as LandingModel;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const mount = (selected: LandingModel | null = model, busy = false) => act(() => root.render(<MemoryRouter><LandingToolsMenu page="/" model={selected} busy={busy}
  generationSettings={{ open: false, controls: 'settings', onOpen: vi.fn() }} /></MemoryRouter>));

it('puts export/import first, separates groups, and keeps Community/GitHub last', () => {
  mount(); act(() => button('Tools').click());
  const rows = [...host.querySelectorAll('ul[aria-label="Tools"] > li')];
  expect(rows.map(row => row.textContent)).toEqual(['Export', 'Import', '', 'Image to LEGO', 'GLB to LEGO', 'OBJ to LEGO', '', 'Generation settings', 'Build Buddy', '', 'Feedback', 'Community', 'GitHub', '', 'Support']);
  expect(host.querySelectorAll('[role="separator"]')).toHaveLength(4);
  expect(button('Export').querySelector('.lucide-download')).not.toBeNull();
  act(() => button('Import').click());
  expect([...host.querySelectorAll('[aria-label="Import options"] a')].map(node => node.getAttribute('href'))).toEqual(['/use-ai-to-edit-ldraw?format=ldraw', '/use-ai-to-edit-ldraw?format=io']);
  act(() => button('Export').click());
  expect(host.querySelector('[aria-label="Import options"]')).toBeNull();
  expect(button('Download parts list CSV').closest('li')?.className).toContain('border-t');
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
