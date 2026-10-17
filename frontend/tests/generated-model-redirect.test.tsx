import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { GeneratedModelRedirect } from '../src/components/GeneratedModelRedirect';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); localStorage.clear(); });

function Destination() {
  const location = useLocation();
  const navigate = useNavigate();
  return <><output>{location.pathname}{location.search}{location.hash}</output><button onClick={() => navigate(-1)}>Back</button></>;
}

it.each([
  ['/generated-model?id=model%20%26%20revision&exact=1#viewer', '/?id=model+%26+revision&exact=1#viewer'],
  ['/generated-model?id=pending', '/?id=pending'],
  ['/generated-model', '/'],
])('redirects legacy link %s to the landing workspace and replaces the old history entry', async (legacy, destination) => {
  await act(async () => root.render(<MemoryRouter initialEntries={['/dashboard', legacy]}>
    <Routes><Route path="/generated-model" element={<GeneratedModelRedirect />} /><Route path="*" element={<Destination />} /></Routes>
  </MemoryRouter>));
  expect(container.querySelector('output')?.textContent).toBe(destination);
  act(() => container.querySelector('button')!.click());
  expect(container.querySelector('output')?.textContent).toBe('/dashboard');
});

it('restores old model links without an ID from the last generation', async () => {
  localStorage.setItem('lastGenerationId', 'last & model');
  await act(async () => root.render(<MemoryRouter initialEntries={['/generated-model']}>
    <Routes><Route path="/generated-model" element={<GeneratedModelRedirect />} /><Route path="/" element={<Destination />} /></Routes>
  </MemoryRouter>));
  expect(container.querySelector('output')?.textContent).toBe('/?id=last+%26+model');
});
