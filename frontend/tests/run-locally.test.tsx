import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import posthog from 'posthog-js';
import { RunLocallyButton, LOCAL_SETUP_PROMPT } from '../src/components/RunLocallyButton';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const button = (label: string) => Array.from(container.querySelectorAll('button')).find(item => item.textContent === label)!;
beforeEach(() => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  act(() => root.render(<RunLocallyButton />));
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
it('opens the accessible dialog, copies the complete prompt, and restores focus on close', async () => {
  act(() => button('Run on your computer').click());
  const dialog = container.querySelector('dialog')!;
  expect(dialog.open).toBe(true);
  expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Run on your computer');
  await act(async () => button('Copy prompt').click());
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(LOCAL_SETUP_PROMPT);
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Ready to paste');
  expect(posthog.capture).toHaveBeenCalledWith('run_locally_prompt_copied', { source: 'header' });
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Close local setup"]')!.click());
  expect(dialog.open).toBe(false);
  expect(document.activeElement).toBe(button('Run on your computer'));
});
it('keeps the prompt selectable when clipboard access fails and resets status on reopening', async () => {
  vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error('Denied'));
  act(() => button('Run on your computer').click());
  await act(async () => button('Copy prompt').click());
  expect(container.querySelector('[role="status"]')?.textContent).toContain('copy it manually');
  expect(container.querySelector('textarea')?.value).toBe(LOCAL_SETUP_PROMPT);
  act(() => container.querySelector('dialog')!.close());
  act(() => button('Run on your computer').click());
  expect(container.querySelector('[role="status"]')?.textContent).toBe('');
});
it('keeps README instructions identical to the prompt users copy', () => {
  const readme = readFileSync('../README.md', 'utf8');
  expect(readme).toContain('```markdown\n' + LOCAL_SETUP_PROMPT + '\n```');
});
