import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { ModelShareMenu } from '../src/components/ModelShareMenu';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
const writeText = vi.fn();
beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  act(() => root.render(<ModelShareMenu generationId="revision & 2" modelName="Cat & dog" />));
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const open = () => act(() => container.querySelector('button')!.click());
const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent?.includes(label))!;

it('shares the exact displayed revision with encoded URLs and no unrelated query parameters', async () => {
  open();
  const url = new URL('/generated-model?id=revision%20%26%202&exact=1', window.location.origin).href;
  const facebook = container.querySelector<HTMLAnchorElement>('a[href*="facebook"]')!;
  const twitter = container.querySelector<HTMLAnchorElement>('a[href*="twitter"]')!;
  expect(new URL(facebook.href).searchParams.get('u')).toBe(url);
  expect(new URL(twitter.href).searchParams.get('url')).toBe(url);
  expect(new URL(twitter.href).searchParams.get('text')).toBe('Check out Cat & dog on BrickBuilder!');
  expect(facebook.rel).toContain('noopener');
  await act(async () => button('Copy link').click());
  expect(writeText).toHaveBeenCalledWith(url);
  expect(container.querySelector('[role="status"]')!.textContent).toBe('Link copied!');
  expect(posthog.capture).toHaveBeenCalledWith('generated_model_share_clicked', { generation_id: 'revision & 2', destination: 'url' });
});

it('copies an Instagram link and explains where to paste it', async () => {
  open();
  await act(async () => button('Instagram').click());
  expect(writeText).toHaveBeenCalledOnce();
  expect(container.querySelector('[role="status"]')!.textContent).toContain('Instagram message or story link sticker');
});

it('provides a selected manual-copy fallback when clipboard access fails', async () => {
  writeText.mockRejectedValue(new Error('Permission denied'));
  open();
  await act(async () => button('Copy link').click());
  const input = container.querySelector('input')!;
  expect(document.activeElement).toBe(input);
  expect(input.selectionEnd).toBe(input.value.length);
  expect(container.textContent).toContain('Select and copy');
  expect(container.textContent).not.toContain('Link copied!');
});

it('focuses actions, closes with Escape or outside click, and restores trigger focus on Escape', () => {
  open();
  expect(document.activeElement).toBe(button('Copy link'));
  act(() => button('Copy link').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(container.querySelector('button'));
  open();
  act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it('closes after a social link and resets the menu when navigating to another revision', () => {
  open();
  act(() => container.querySelector('a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  open();
  act(() => root.render(<ModelShareMenu generationId="next" modelName="Next" />));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  open();
  expect(container.querySelector('input')!.value).toContain('id=next&exact=1');
});
