import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { CopyableArticle } from '../src/components/CopyableArticle';
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
it('copies the exact decoded multiline prompt without toolbar text and reports success', async () => {
  act(() => root.render(<CopyableArticle content={'<pre><code># Install\n\nnpm install &amp;&amp; npm start</code></pre>'} />));
  await act(async () => container.querySelector('button')!.click());
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith('# Install\n\nnpm install && npm start');
  expect(container.querySelector('button')!.textContent).toBe('Copied!');
  expect(container.querySelector('svg')).not.toBeNull();
  expect(posthog.capture).toHaveBeenCalledWith('blog_code_copied', { source: 'article' });
});
it('provides a manual copy fallback when clipboard access fails', async () => {
  vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error('Denied'));
  act(() => root.render(<CopyableArticle content="<pre>npm start</pre>" />));
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('[role="status"]')!.textContent).toContain('copy it manually');
  expect(container.querySelector('pre')!.textContent).toBe('npm start');
});
it('updates copy controls on article navigation and removes them for prose-only articles', async () => {
  act(() => root.render(<CopyableArticle content="<pre>first</pre><pre>second</pre>" />));
  expect(container.querySelectorAll('button')).toHaveLength(2);
  act(() => root.render(<CopyableArticle content="<pre>replacement</pre>" />));
  expect(container.querySelectorAll('button')).toHaveLength(1);
  await act(async () => container.querySelector('button')!.click());
  expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith('replacement');
  act(() => root.render(<CopyableArticle content="<p>No code</p>" />));
  expect(container.querySelectorAll('button')).toHaveLength(0);
});
