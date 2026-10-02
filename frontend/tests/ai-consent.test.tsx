import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { SiteFooter } from '../src/components/SiteFooter';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../src/services/apiFetch';
import { AI_CONSENT_KEY, AI_CONSENT_VERSION, ensureAiConsent, hasAiConsent, openAiConsentSettings, registerAiConsentPrompt, requiresAiConsent, saveAiConsent } from '../src/utils/aiConsent';
import { AiConsentDialog } from '../src/components/AiConsentDialog';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
let unregister: (() => void) | undefined;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

beforeEach(() => {
  localStorage.clear();
  window.__BRICKBUILDER_NATIVE_APP__ = { platform: 'ios', version: '1.0' };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(async () => {
  unregister?.();
  unregister = undefined;
  if (root) await act(async () => root?.unmount());
  root = undefined;
  host?.remove();
  delete window.__BRICKBUILDER_NATIVE_APP__;
  vi.unstubAllGlobals();
});

describe('AI sharing permission', () => {
  it('leaves ordinary desktop and mobile websites ungated and hides consent controls', async () => {
    delete window.__BRICKBUILDER_NATIVE_APP__;
    const prompt = vi.fn().mockResolvedValue(false);
    unregister = registerAiConsentPrompt(prompt);
    await apiFetch('/llmToBricks/stream', { method: 'POST' });
    await apiFetch('/imageToBricks', { method: 'POST' });
    await ensureAiConsent();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(prompt).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(<AiConsentDialog />)).toBe('');
    expect(renderToStaticMarkup(<MemoryRouter><SiteFooter /></MemoryRouter>)).not.toContain('AI privacy');
  });

  it('retains mobile permission controls only with a valid Expo shell marker', () => {
    expect(renderToStaticMarkup(<MemoryRouter><SiteFooter /></MemoryRouter>)).toContain('AI privacy');
    window.__BRICKBUILDER_NATIVE_APP__ = { platform: 'other', version: '1.0' } as never;
    expect(requiresAiConsent('/llmToBricks', 'POST')).toBe(false);
    expect(renderToStaticMarkup(<AiConsentDialog />)).toBe('');
  });

  it.each(['llmToBricks', 'llmToBricks/stream', 'llmRender/stream', 'textToBricks', 'imageToBricks', 'promptEditModel', 'glbToBricks', 'resizeModel', 'updateModel'])('protects %s', endpoint => {
    expect(requiresAiConsent(`https://backend.test/${endpoint}`, 'POST')).toBe(true);
    expect(requiresAiConsent(`/${endpoint}`, 'GET')).toBe(false);
  });

  it('holds the entire request until permission, including concurrent requests', async () => {
    let decide: (allowed: boolean) => void = () => {};
    const prompt = vi.fn(() => new Promise<boolean>(resolve => { decide = resolve; }));
    unregister = registerAiConsentPrompt(prompt);
    const first = apiFetch('/llmToBricks', { method: 'POST', body: '{"prompt":"private"}' });
    const second = apiFetch('/imageToBricks', { method: 'POST' });
    expect(fetch).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledTimes(1);
    decide(true);
    await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('declining sends no content and allows a later retry', async () => {
    const prompt = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    unregister = registerAiConsentPrompt(prompt);
    await expect(apiFetch('/llmToBricks', { method: 'POST' })).rejects.toThrow('not sent');
    expect(fetch).not.toHaveBeenCalled();
    await apiFetch('/llmToBricks', { method: 'POST' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fails closed if the app has no consent UI', async () => {
    await expect(ensureAiConsent()).rejects.toThrow('unavailable');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps browsing and physical-brick checkout available without consent', async () => {
    await apiFetch('/generation/g1');
    await apiFetch('/createCheckoutSession', { method: 'POST' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('remembers only current permission and asks again after withdrawal or a disclosure change', async () => {
    const prompt = vi.fn().mockResolvedValue(true);
    unregister = registerAiConsentPrompt(prompt);
    saveAiConsent(true);
    await ensureAiConsent();
    expect(prompt).not.toHaveBeenCalled();
    saveAiConsent(false);
    expect(hasAiConsent()).toBe(false);
    await ensureAiConsent();
    localStorage.setItem(AI_CONSENT_KEY, 'old-disclosure');
    await ensureAiConsent();
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('does not send a request aborted while the user considers permission', async () => {
    let decide: (allowed: boolean) => void = () => {};
    unregister = registerAiConsentPrompt(() => new Promise(resolve => { decide = resolve; }));
    const controller = new AbortController();
    const request = apiFetch('/textToBricks', { method: 'POST', signal: controller.signal });
    controller.abort();
    decide(true);
    await expect(request).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('discloses recipients, saves an explicit choice, and supports withdrawal', async () => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function () { this.setAttribute('open', ''); } });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function () { this.removeAttribute('open'); } });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root?.render(<AiConsentDialog />));
    let request: Promise<Response>;
    await act(async () => { request = apiFetch('/llmToBricks', { method: 'POST' }); });
    const dialog = host.querySelector('dialog')!;
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain('OpenAI, Anthropic, fal.ai, and RunPod');
    expect(dialog.textContent).toContain('reference images or photos');
    expect(localStorage.getItem(AI_CONSENT_KEY)).toBeNull();
    await act(async () => (Array.from(host!.querySelectorAll('button')).find(button => button.textContent === 'Allow AI processing')!).click());
    await request!;
    expect(localStorage.getItem(AI_CONSENT_KEY)).toBe(AI_CONSENT_VERSION);
    let settings: Promise<boolean>;
    await act(async () => { settings = openAiConsentSettings(); });
    await act(async () => (Array.from(host!.querySelectorAll('button')).find(button => button.textContent === 'Withdraw permission')!).click());
    expect(await settings!).toBe(false);
    expect(hasAiConsent()).toBe(false);
    expect(dialog.open).toBe(false);
  });
});
