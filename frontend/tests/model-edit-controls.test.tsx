import React from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { ModelEditControls } from '../src/components/ModelEditControls';

describe('ModelEditControls', () => {
  it('labels the block editor action Manually Edit', () => {
    const container = document.createElement('div');
    const root = createRoot(container);

    try {
      act(() => {
        root.render(
          <ModelEditControls
            isManualEditorOpen={false}
            manualLoading={false}
            onManualEdit={vi.fn()}
          />,
        );
      });

      expect(container.textContent).toBe('Manually Edit');
      expect(container.querySelector('[aria-label="Manually edit model"]')).not.toBeNull();
      expect(container.querySelector('[aria-label="AI edit model"]')).toBeNull();
      expect(container.querySelector('[aria-label="Thinking level"]')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('opens the editor from the Manually Edit action', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const onManualEdit = vi.fn();

    try {
      act(() => {
        root.render(
          <ModelEditControls
            isManualEditorOpen={false}
            manualLoading={false}
            onManualEdit={onManualEdit}
          />,
        );
      });

      act(() => {
        (container.querySelector('[aria-label="Manually edit model"]') as HTMLButtonElement).click();
      });
      expect(onManualEdit).toHaveBeenCalledOnce();
    } finally {
      act(() => root.unmount());
    }
  });

  it('shows the exit action while the block editor is open', () => {
    const container = document.createElement('div');
    const root = createRoot(container);

    try {
      act(() => {
        root.render(
          <ModelEditControls
            isManualEditorOpen
            manualLoading={false}
            onManualEdit={vi.fn()}
          />,
        );
      });

      expect(container.textContent).toBe('Exit Block Editor');
      expect(container.querySelector('[aria-label="Exit block editor"]')).not.toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });
});
