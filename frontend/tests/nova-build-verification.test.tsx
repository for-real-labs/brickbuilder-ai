import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { NovaBuildVerification } from '../src/components/NovaBuildVerification';

describe('Nova build verification', () => {
  it('labels previews, explains additional credit use, and starts verification', () => {
    const node = document.createElement('div'), root = createRoot(node), verify = vi.fn();
    try {
      act(() => root.render(<NovaBuildVerification verified={false} busy={false} canVerify onVerify={verify} />));
      expect(node.textContent).toContain('Unchecked preview');
      expect(node.textContent).toContain('1 additional credit');
      act(() => (node.querySelector('button') as HTMLButtonElement).click());
      expect(verify).toHaveBeenCalledOnce();
    } finally { act(() => root.unmount()); }
  });

  it.each([{ busy: true, canVerify: true }, { busy: false, canVerify: false }])(
    'blocks duplicate and non-owner verification: %o', props => {
      const node = document.createElement('div'), root = createRoot(node), verify = vi.fn();
      try {
        act(() => root.render(<NovaBuildVerification verified={false} {...props} onVerify={verify} />));
        expect((node.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
        act(() => (node.querySelector('button') as HTMLButtonElement).click());
        expect(verify).not.toHaveBeenCalled();
      } finally { act(() => root.unmount()); }
    });

  it('distinguishes completed verification and keeps errors readable', () => {
    const node = document.createElement('div'), root = createRoot(node);
    try {
      act(() => root.render(<NovaBuildVerification verified busy={false} canVerify onVerify={vi.fn()} error="Unable to verify" />));
      expect(node.textContent).toContain('Build verified');
      expect(node.textContent).toContain('Any new edit creates a new unchecked preview');
      expect(node.querySelector('[role="alert"]')?.textContent).toBe('Unable to verify');
    } finally { act(() => root.unmount()); }
  });
});
