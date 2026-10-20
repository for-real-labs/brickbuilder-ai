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
    expect(container.querySelector('[aria-label="Build buddy is typing"]')).not.toBeNull();
    expect(container.querySelector('.pet-avatar--listening')).not.toBeNull();
    expect(container.textContent).not.toContain('Let me take a look');
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

it('uses the saved subject edit example as a placeholder without filling or submitting the input', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    act(() => root.render(<VoxelPromptEditor prompt="" examplePrompt="Make the fins blue and add a longer tail" modelName="Fish"
      onPromptChange={vi.fn()} onSubmit={vi.fn()} loading={false} disabled={false} error={null} />));
    expect(container.querySelector('textarea')?.placeholder).toBe('e.g. Make the fins blue and add a longer tail');
    expect(container.querySelector('textarea')?.value).toBe('');
    expect(container.querySelector('button[type="submit"]')?.disabled).toBe(true);
    act(() => root.render(<VoxelPromptEditor prompt="My own edit" modelName="Crocodile"
      onPromptChange={vi.fn()} onSubmit={vi.fn()} loading={false} disabled={false} error={null} />));
    expect(container.querySelector('textarea')?.placeholder).toContain('Crocodile');
    expect(container.querySelector('textarea')?.value).toBe('My own edit');
  } finally { act(() => root.unmount()); }
});

it('uploads, submits and removes a reference image while retaining text on failure', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const submit = vi.fn().mockResolvedValue(undefined);
  try {
    await act(async () => root.render(<VoxelPromptEditor prompt="Match these colors" onPromptChange={vi.fn()}
      onSubmit={submit} loading={false} disabled={false} error={null} />));
    const picker = container.querySelector('input[type="file"]') as HTMLInputElement;
    const pick = vi.spyOn(picker, 'click');
    act(() => (container.querySelector('[aria-label="Upload edit image"]') as HTMLButtonElement).click());
    expect(pick).toHaveBeenCalledOnce();
    Object.defineProperty(picker, 'files', { configurable: true, value: [new File(['pixels'], 'reference.png', { type: 'image/png' })] });
    await act(async () => {
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 40));
    });
    expect(container.querySelector('img[alt="Edit reference"]')?.getAttribute('src')).toBe('data:image/png;base64,cGl4ZWxz');
    await act(async () => { container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(submit).toHaveBeenCalledWith({ imageBase64: 'cGl4ZWxz', imageMediaType: 'image/png' });
    expect(container.querySelector('img[alt="Edit reference"]')).not.toBeNull();
    act(() => (container.querySelector('[aria-label="Remove edit image"]') as HTMLButtonElement).click());
    expect(container.querySelector('img[alt="Edit reference"]')).toBeNull();
    await act(async () => { container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(submit).toHaveBeenLastCalledWith(undefined);
  } finally { act(() => root.unmount()); }
});

it('rejects non-images and disables image controls while editing', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = (loading: boolean) => root.render(<VoxelPromptEditor prompt="Red roof" onPromptChange={vi.fn()}
    onSubmit={vi.fn()} loading={loading} disabled={false} error={null} />);
  try {
    await act(async () => render(false));
    const picker = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(picker, 'files', { value: [new File(['text'], 'notes.txt', { type: 'text/plain' })] });
    await act(async () => { picker.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Please choose an image file.');
    expect(container.querySelector('img[alt="Edit reference"]')).toBeNull();
    await act(async () => render(true));
    expect(picker.disabled).toBe(true);
    expect((container.querySelector('[aria-label="Upload edit image"]') as HTMLButtonElement).disabled).toBe(true);
  } finally { act(() => root.unmount()); }
});
