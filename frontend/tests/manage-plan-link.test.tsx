import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { ManagePlanLink } from '../src/components/ManagePlanLink';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));

it.each(['dashboard_sidebar', 'dashboard_overview'])('opens billing and closes navigation from %s', async source => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const close = vi.fn();
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={['/dashboard']}><Routes>
      <Route path="/dashboard" element={<ManagePlanLink source={source} onClick={close} />} />
      <Route path="/billing" element={<h1>Credits & billing</h1>} />
    </Routes></MemoryRouter>));
    const link = container.querySelector('a')!;
    expect(link.textContent).toBe('Manage Plan');
    expect(link.getAttribute('href')).toBe('/billing');
    await act(async () => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
    expect(container.querySelector('h1')?.textContent).toBe('Credits & billing');
    expect(close).toHaveBeenCalledOnce();
    expect(posthog.capture).toHaveBeenCalledWith('billing_navigation_clicked', { source, destination: '/billing' });
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
