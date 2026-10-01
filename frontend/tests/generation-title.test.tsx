import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { GenerationTitle } from '../src/components/GenerationTitle';
import { UpdateGenerationNameApiService } from '../src/services/updateGenerationNameApi';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
function changeName(value: string) {
  const input = container.querySelector('input')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

it('shows the title to visitors and offers editing only for an owned, persisted model', () => {
  act(() => root.render(<GenerationTitle name="Dachshund in Shades" generationId="other" canEdit={false} />));
  expect(container.querySelector('h1')?.textContent).toBe('Dachshund in Shades');
  expect(container.querySelector('button')).toBeNull();
  act(() => root.render(<GenerationTitle name="Dachshund in Shades" canEdit />));
  expect(container.querySelector('button')).toBeNull();
});

it('saves a trimmed title through the owner endpoint and reflects the server response', async () => {
  const save = vi.spyOn(UpdateGenerationNameApiService, 'updateGenerationName').mockResolvedValue({ generation_id: 'mine', name: 'Sunny Dachshund' });
  const done = vi.fn();
  act(() => root.render(<GenerationTitle name="Dachshund in Shades" generationId="mine" canEdit accessToken="token" onSaved={done} />));
  act(() => container.querySelector('button')!.click());
  act(() => changeName('  Sunny Dachshund  '));
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(save).toHaveBeenCalledWith('mine', 'Sunny Dachshund', 'token');
  expect(done).toHaveBeenCalledWith('Sunny Dachshund');
  expect(container.querySelector('form')).toBeNull();
  expect(posthog.capture).toHaveBeenCalledWith('generation_name_saved', { generation_id: 'mine', name_length: 15 });
});

it('retains the draft after an error and permits a retry without changing the visible title', async () => {
  const save = vi.spyOn(UpdateGenerationNameApiService, 'updateGenerationName').mockRejectedValueOnce(new Error('403')).mockResolvedValueOnce({generation_id: 'mine', name: 'New Name'});
  const done = vi.fn();
  act(() => root.render(<GenerationTitle name="Original" generationId="mine" canEdit onSaved={done} />));
  act(() => container.querySelector('button')!.click());
  act(() => changeName('New Name'));
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not save');
  expect(container.querySelector('input')?.value).toBe('New Name');
  expect(done).not.toHaveBeenCalled();
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
  expect(save).toHaveBeenCalledTimes(2);
  expect(done).toHaveBeenCalledWith('New Name');
});

it('rejects whitespace, cancels on Escape, and closes editing when ownership is revoked', async () => {
  const save = vi.spyOn(UpdateGenerationNameApiService, 'updateGenerationName');
  act(() => root.render(<GenerationTitle name="Original" generationId="mine" canEdit />));
  act(() => container.querySelector('button')!.click());
  act(() => changeName('   '));
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
  expect(save).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  act(() => container.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})));
  expect(container.querySelector('h1')?.textContent).toBe('Original');
  act(() => container.querySelector('button')!.click());
  act(() => root.render(<GenerationTitle name="Original" generationId="mine" canEdit={false} />));
  expect(container.querySelector('input')).toBeNull();
  expect(container.querySelector('button')).toBeNull();
});
