import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { CompatibleBricks } from '../src/components/CompatibleBricks';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
  vi.mocked(posthog.capture).mockClear();
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it.each(['button', 'escape', 'backdrop'])('explains the supplier and export alternative, then closes by %s and restores focus', method => {
  act(() => root.render(<CompatibleBricks source="order_summary" />));
  expect(container.textContent).toBe('LEGO® compatible bricks');
  const trigger = container.querySelector('button')!;
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(document.querySelector('dialog')).toBeNull();
  trigger.focus();
  act(() => trigger.click());
  const dialog = document.querySelector('dialog')!;
  expect(dialog.open).toBe(true);
  expect(dialog.textContent).toContain('Gobricks are used instead of LEGO® bricks. They are 100% compatible with LEGO®.');
  expect(dialog.textContent).toContain('If you require LEGO® bricks, please download the parts list in Tools → Export and upload it to BrickLink or BrickOwl.');
  expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('About your bricks');
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(document.body.style.overflow).toBe('hidden');
  expect(posthog.capture).toHaveBeenCalledWith('order_brick_compatibility_opened', { source: 'order_summary' });
  act(() => {
    if (method === 'escape') dialog.dispatchEvent(new Event('cancel', { bubbles: true, cancelable: true }));
    else if (method === 'backdrop') dialog.click();
    else dialog.querySelector<HTMLButtonElement>('.compatible-bricks-done')!.click();
  });
  expect(document.querySelector('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(document.body.style.overflow).toBe('');
  expect(posthog.capture).toHaveBeenCalledWith('order_brick_compatibility_closed', { source: 'order_summary' });
});
