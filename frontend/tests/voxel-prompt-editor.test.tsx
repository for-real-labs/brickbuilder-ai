import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { VoxelPromptEditor } from '../src/components/VoxelPromptEditor';

it('submits a requested edit and prevents empty or duplicate submissions', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const submit = vi.fn();
  const render = (prompt: string, loading = false, error: string | null = null) => act(() => root.render(
    <VoxelPromptEditor prompt={prompt} onPromptChange={vi.fn()} onSubmit={submit} loading={loading} disabled={false} error={error} />,
  ));
  try {
    render('');
    expect(container.querySelector('button')?.disabled).toBe(true);
    render('red roof');
    act(() => container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(submit).toHaveBeenCalledOnce();
    render('red roof', true);
    act(() => container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(submit).toHaveBeenCalledOnce();
    expect(container.querySelector('textarea')?.disabled).toBe(true);
    render('red roof', false, 'Try again');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Try again');
  } finally { act(() => root.unmount()); }
});
