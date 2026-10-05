import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { VoxelPromptEditor } from '../src/components/VoxelPromptEditor';
import { ModelEditControls } from '../src/components/ModelEditControls';

it('submits a requested edit and prevents empty or duplicate submissions', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const submit = vi.fn();
  const render = (prompt: string, loading = false, error: string | null = null) => act(() => root.render(
    <VoxelPromptEditor prompt={prompt} onPromptChange={vi.fn()} onSubmit={submit} loading={loading} disabled={false} error={error} />,
  ));
  try {
    render('');
    expect(container.querySelector('button[type="submit"]')?.disabled).toBe(true);
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

it('labels the refine input and keeps manual edits separate from submitting a prompt', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const submit = vi.fn();
  const manualEdit = vi.fn();
  try {
    act(() => root.render(<VoxelPromptEditor
      prompt="Red roof" onPromptChange={vi.fn()} onSubmit={submit} loading={false} disabled={false} error={null}
      manualEditControl={<ModelEditControls isManualEditorOpen={false} manualLoading={false} onManualEdit={manualEdit} />}
    />));
    expect(container.querySelector('label')?.textContent).toBe('Refine your model');
    expect(container.textContent).not.toContain('Each edit uses 1 credit');
    expect(container.querySelector('textarea')?.placeholder).toBe('e.g. Make the roof red and add a chimney…');
    const buttons = container.querySelectorAll('button[type="submit"], [aria-label="Manually edit model"]');
    expect(buttons[0].textContent).toBe('Apply Edit');
    expect(buttons[1].textContent).toBe('Manually Edit');
    expect(buttons[1].type).toBe('button');
    act(() => buttons[1].click());
    expect(manualEdit).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  } finally { act(() => root.unmount()); }
});


it('fills and focuses a suggestion without submitting an edit, and locks suggestions during an update', () => {
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  const change = vi.fn(), selected = vi.fn(), submit = vi.fn();
  const render = (disabled = false) => act(() => root.render(<VoxelPromptEditor prompt="" onPromptChange={change}
    onSuggestionSelected={selected} onSubmit={submit} loading={false} disabled={disabled} error={null} />));
  try {
    render();
    act(() => (container.querySelector('.model-edit-suggestions button') as HTMLButtonElement).click());
    expect(change).toHaveBeenCalledWith('Use a brighter, more vibrant color palette.');
    expect(selected).toHaveBeenCalledWith('colors');
    expect(document.activeElement).toBe(container.querySelector('textarea'));
    expect(submit).not.toHaveBeenCalled();
    render(true);
    expect(Array.from(container.querySelectorAll('.model-edit-suggestions button')).every(button => (button as HTMLButtonElement).disabled)).toBe(true);
  } finally { act(() => root.unmount()); container.remove(); }
});
