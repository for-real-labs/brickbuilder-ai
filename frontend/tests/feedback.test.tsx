import React from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { FeedbackWidget } from '../src/components/FeedbackWidget';
import { contentReportPage, CONTENT_REPORT_PREFIX, FEEDBACK_ENDPOINT, MAX_FEEDBACK_LENGTH, sendFeedback } from '../src/services/feedbackApi';
import posthog from 'posthog-js';

const auth = vi.hoisted(() => ({ user: null as { email: string } | null, loading: false }));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  auth.user = null;
  auth.loading = false;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function () { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function () { this.open = false; this.dispatchEvent(new Event('close')); } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(path = '/community', variant: 'feedback' | 'content-report' = 'feedback') {
  act(() => root.render(<MemoryRouter initialEntries={[path]}><FeedbackWidget variant={variant} /></MemoryRouter>));
}
function open() {
  act(() => container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!.click());
}
function describe(text: string) {
  act(() => {
    const field = container.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() {
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}

it.each(['/order', '/generated-model'])('keeps purchase controls on %s clear of the floating feedback trigger', path => {
  render(path);
  expect(container.querySelector('[aria-haspopup="dialog"]')).toBeNull();
  expect(document.body.style.overflow).not.toBe('hidden');
});

it.each(['/','/community','/login'])('opens and closes feedback on %s and restores focus', path => {
  render(path);
  const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
  open();
  expect(container.querySelector('dialog')!.open).toBe(true);
  expect(document.body.style.overflow).toBe('hidden');
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Close feedback"]')!.click());
  expect(container.querySelector('dialog')!.open).toBe(false);
  expect(document.activeElement).toBe(trigger);
  expect(document.body.style.overflow).not.toBe('hidden');
});

it.each([null, { email: 'jake@example.com' }])('submits the description with the correct identity: %s', user => {
  auth.user = user;
  render();
  open();
  describe('  Please improve the instructions.  ');
  return submit().then(() => {
    expect(fetch).toHaveBeenCalledWith(FEEDBACK_ENDPOINT, expect.objectContaining({ method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' } }));
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body).toEqual({ description: 'Please improve the instructions.', page: '/community', user: user?.email || 'anon user', ...(user ? { email: user.email } : {}) });
    expect(container.textContent).toContain('Your message has been sent.');
    expect(posthog.capture).toHaveBeenCalledWith('feedback_submitted', { page: '/community', is_authenticated: Boolean(user) });
  });
});

it('keeps the draft and allows retry after a rejected submission', async () => {
  vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response);
  render(); open(); describe('A button is broken');
  await submit();
  expect(container.querySelector('textarea')!.value).toBe('A button is broken');
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('Please try again');
  await submit();
  expect(container.textContent).toContain('Your message has been sent.');
});

it('prevents empty and duplicate submissions while a request is pending', async () => {
  let finish!: (value: Response) => void;
  vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(); open();
  await submit();
  expect(fetch).not.toHaveBeenCalled();
  describe('Feedback');
  await submit();
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  await submit();
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => finish({ ok: true } as Response));
});

it('rejects invalid descriptions and reports network errors', async () => {
  await expect(sendFeedback(' ', undefined, '/')).rejects.toThrow('description');
  await expect(sendFeedback('x'.repeat(5001), undefined, '/')).rejects.toThrow('5,000');
  expect(fetch).not.toHaveBeenCalled();
  vi.mocked(fetch).mockRejectedValue(new Error('offline'));
  await expect(sendFeedback('Feedback', undefined, '/')).rejects.toThrow('Please try again');
});

it('lets guests report a model in-app and sends its reference without private query data', async () => {
  const model = 'e3438737-7c21-4d67-9d04-b19412fe3ca2';
  render(`/generated-model?id=${model}&access_token=private&email=private@example.com`, 'content-report');
  expect(container.querySelector('button')!.textContent).toContain('Report model');
  open();
  expect(container.querySelector('dialog')!.open).toBe(true);
  expect(container.textContent).toContain('Report this model');
  describe('  This model contains offensive content.  ');
  await submit();
  const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
  expect(body).toEqual({ description: `${CONTENT_REPORT_PREFIX}This model contains offensive content.`, user: 'anon user', page: `/generated-model?id=${model}` });
  expect(container.textContent).toContain('Your report has been sent for review.');
  expect(posthog.capture).toHaveBeenCalledWith('content_report_submitted', { page: '/generated-model', is_authenticated: false });
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Close report"]')!.click());
  expect(document.activeElement).toBe(container.querySelector('button'));
});

it('keeps unsuccessful reports available for retry and respects the transport length limit', async () => {
  vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response);
  render('/generated-model', 'content-report');
  open();
  const maximum = MAX_FEEDBACK_LENGTH - CONTENT_REPORT_PREFIX.length;
  expect(container.querySelector('textarea')!.maxLength).toBe(maximum);
  describe('x'.repeat(maximum));
  await submit();
  expect(container.querySelector('textarea')!.value).toHaveLength(maximum);
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  await submit();
  expect(container.textContent).toContain('Your report has been sent for review.');
  expect(JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string).description).toHaveLength(MAX_FEEDBACK_LENGTH);
});

it('excludes unrecognized model identifiers and unrelated query parameters from reports', () => {
  expect(contentReportPage('/generated-model', '?id=invalid&token=private')).toBe('/generated-model');
  expect(contentReportPage('/generated-model', '?token=private')).toBe('/generated-model');
  expect(contentReportPage('/generated-model', '?id=%3Cscript%3E')).toBe('/generated-model');
});
