import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { OrderStatusBadge } from '../src/components/OrderStatusBadge';
import { OrderCard } from '../src/pages/UserDashboard';
import { MemoryRouter } from 'react-router-dom';
import type { GenerationWithOrder } from '../src/services/getUserGenerationsApi';

it.each([
  [{}, 'Processing', 'bg-yellow-100'],
  [{ fulfilled: false, cancelled: false }, 'Processing', 'bg-yellow-100'],
  [{ fulfilled: true, cancelled: false }, 'Fulfilled', 'bg-green-100'],
  [{ fulfilled: false, cancelled: true }, 'Cancelled', 'bg-slate-100'],
  // Cancellation wins if stale data contains both flags.
  [{ fulfilled: true, cancelled: true }, 'Cancelled', 'bg-slate-100'],
])('renders order status %j as %s', (order, label, color) => {
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    act(() => root.render(<OrderStatusBadge order={order} />));
    expect(container.textContent?.trim()).toBe(label);
    expect(container.querySelector('span')?.classList.contains(color)).toBe(true);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  } finally { act(() => root.unmount()); }
});

it('shows the cancelled state on an actual order card while retaining paid history and model links', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const generation = {
    id: 'original-cat', prompt: 'Tabby Cat', created_at: '2026-10-01',
    order: { id: 94, generation_id: 'original-cat', amount_paid: '171.60', fulfilled: false, cancelled: true },
  } as GenerationWithOrder;
  try {
    act(() => root.render(<MemoryRouter><OrderCard g={generation} onView={() => {}} /></MemoryRouter>));
    expect(container.textContent).toContain('Cancelled');
    expect(container.textContent).not.toContain('Processing');
    expect(container.textContent).toContain('#94');
    expect(container.textContent).toContain('$171.60');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/instructions?id=original-cat');
  } finally { act(() => root.unmount()); }
});
