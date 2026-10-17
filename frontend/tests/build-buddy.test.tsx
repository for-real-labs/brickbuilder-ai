import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BuildBuddyDialogue, BUDDY_SEEN_KEY } from '../src/components/BuildBuddyDialogue';
import { PetProvider } from '../src/contexts/PetContext';
import { useBuildBuddyChat } from '../src/hooks/useBuildBuddyChat';
import { BuildBuddyApi } from '../src/services/buildBuddyApi';
import { LlmToBricksApiService } from '../src/services/llmToBricksApi';
import { GenerationEmailApi } from '../src/services/generationEmailApi';
import { apiFetch } from '../src/services/apiFetch';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => ({ session: null }) }));
vi.mock('../src/services/apiFetch', () => ({ apiFetch: vi.fn() }));
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(GenerationEmailApi, 'status').mockResolvedValue({ subscribed: false, email: null });
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const renderDialogue = async (username?: string, authLoading = false) => act(async () => root.render(<PetProvider>
  <BuildBuddyDialogue turns={[]} generations={[]} state="idle" username={username} authLoading={authLoading} />
</PetProvider>));

it('introduces Pip in a message, remembers the visit, and removes the two old captions', async () => {
  await renderDialogue();
  expect(container.textContent).toBe('Hi, I’m Pip your build buddy! What would you like to build?');
  expect(container.querySelector('[role="log"]')?.getAttribute('aria-label')).toBe('Build buddy conversation');
  expect(container.querySelector('.pet-speech-heading')).toBeNull();
  expect(container.textContent).not.toContain('Ask Pip to build something');
  expect(localStorage.getItem(BUDDY_SEEN_KEY)).toBe('true');
  // A rerender in the same visit must not turn the introduction into a welcome back.
  await renderDialogue('Jake');
  expect(container.textContent).toContain('Hi, I’m Pip');
});

it.each([undefined, 'Jake'])('welcomes a returning visitor with username %s when available', async username => {
  localStorage.setItem(BUDDY_SEEN_KEY, 'true');
  await renderDialogue(username);
  expect(container.textContent).toBe(`Welcome back${username ? ', Jake' : ''}! What would you like to build?`);
});

it('waits for account details before including a name and works with blocked storage', async () => {
  localStorage.setItem(BUDDY_SEEN_KEY, 'true');
  await renderDialogue('Jake', true);
  expect(container.textContent).not.toContain('Jake');
  await renderDialogue('Jake');
  expect(container.textContent).toContain('Welcome back, Jake!');
  act(() => root.unmount()); root = createRoot(container);
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  await renderDialogue();
  expect(container.textContent).toContain('Hi, I’m Pip');
});

it('shows text and images in order, speaks stream updates, and shows a completed model link', async () => {
  let update!: Parameters<typeof LlmToBricksApiService.watchOutput>[1];
  vi.spyOn(LlmToBricksApiService, 'watchOutput').mockImplementation(async (_id, onOutput, signal) => {
    update = onOutput; return new Promise(resolve => signal.addEventListener('abort', () => resolve(true)));
  });
  const turns = [{ id: 1, text: 'A red dragon', imageUrl: 'data:image/png;base64,eA==', imageName: 'dragon.png',
    reply: 'Those wings will look great in bricks.', generationId: 'job', method: 'nova' }];
  const generations = [{ id: 'job', prompt: 'A red dragon', status: 'processing', endpoint: 'novaToBricks' }];
  await act(async () => root.render(<BuildBuddyDialogue turns={turns} generations={generations} state="building" />));
  expect(container.querySelector('.pet-chat-message--user')?.textContent).toContain('A red dragon');
  expect(container.querySelector('img[alt="dragon.png"]')).not.toBeNull();
  expect(container.textContent!.indexOf('A red dragon')).toBeLessThan(container.textContent!.indexOf('Those wings'));
  act(() => update({ text: 'private implementation', summary: 'Shaping the dragon wings', status: 'processing' }));
  expect(container.textContent).toContain('I’m shaping the dragon wings…');
  expect(container.textContent).not.toContain('private implementation');
  expect(container.textContent).toContain('sometimes up to 30 minutes');
  await act(async () => root.render(<BuildBuddyDialogue turns={turns} generations={[{ ...generations[0], status: 'completed' }]} state="idle" />));
  expect(container.textContent).toContain('Your build is ready');
  expect(container.querySelector('a')?.getAttribute('href')).toBe('/generated-model?id=job&exact=1');
  expect(container.querySelector('.pet-notification-conversation')).toBeNull();
});

it.each(['failed', 'cancelled'])('speaks a terminal %s build without opening another stream', async status => {
  const watch = vi.spyOn(LlmToBricksApiService, 'watchOutput');
  await act(async () => root.render(<BuildBuddyDialogue
    turns={[{ id: 1, text: 'Castle', reply: 'Great idea.', generationId: 'job', method: 'llm' }]}
    generations={[{ id: 'job', prompt: 'Castle', endpoint: 'llmToBricks', status, errorMessage: 'Internal runtime error' }]} state="idle" />));
  expect(container.textContent).toContain(status === 'failed'
    ? 'Woops! Something in the brickverse is down. Try again later' : 'I’ve stopped this build.');
  expect(container.textContent).not.toContain('Internal runtime error');
  expect(watch).not.toHaveBeenCalled();
});

it.each([undefined, 'job'])('shows one pet failure message without infrastructure details for generation %s', async generationId => {
  const watch = vi.spyOn(LlmToBricksApiService, 'watchOutput');
  await act(async () => root.render(<BuildBuddyDialogue
    turns={[{ id: 1, text: 'A cat', reply: 'Let’s give your idea another try.',
      error: 'Cannot reach the Nova runtime. Check the private connection.', generationId, method: 'nova' }]}
    generations={generationId ? [{ id: generationId, prompt: 'A cat', endpoint: 'novaToBricks', status: 'failed' }] : []}
    state="idle" />));
  const message = container.querySelector('[role="status"]');
  expect(message?.textContent).toBe('Woops! Something in the brickverse is down. Try again later');
  expect(message?.closest('.pet-chat-message')).not.toBeNull();
  expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
  expect(container.textContent).not.toContain('Nova runtime');
  expect(container.textContent).not.toContain('private connection');
  expect(container.textContent).not.toContain('Let’s give your idea another try.');
  expect(watch).not.toHaveBeenCalled();
});

it('keeps API replies with the right user turn, supplies history, and releases image URLs and requests on unmount', async () => {
  let chat!: ReturnType<typeof useBuildBuddyChat>;
  function Probe() { chat = useBuildBuddyChat('pip', 'account-token'); return <>{chat.turns.map(turn => <p key={turn.id}>{turn.text}:{turn.reply}</p>)}</>; }
  let respond!: (reply: string) => void;
  const reply = vi.spyOn(BuildBuddyApi, 'reply').mockImplementationOnce(() => new Promise(resolve => { respond = resolve; })).mockResolvedValue('A blue boat sounds fun!');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:reference') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  await act(async () => root.render(<Probe />));
  let first!: number;
  act(() => { first = chat.startTurn('Dragon', new File(['x'], 'dragon.png', { type: 'image/png' })); });
  act(() => chat.requestReply(first, 'Dragon', 'eA==', 'image/png'));
  expect(reply).toHaveBeenCalledWith(expect.objectContaining({ pet: 'pip', imageBase64: 'eA==', history: [] }), 'account-token', expect.any(AbortSignal));
  let second!: number;
  act(() => { second = chat.startTurn('Blue boat', null); });
  await act(async () => chat.requestReply(second, 'Blue boat'));
  expect(reply.mock.calls[1][0].history).toEqual([{ role: 'user', text: 'Dragon' }]);
  await act(async () => respond('A dragon sounds fun!'));
  expect(chat.turns.map(turn => turn.reply)).toEqual(['A dragon sounds fun!', 'A blue boat sounds fun!']);
  const signal = reply.mock.calls[0][2];
  expect(signal.aborted).toBe(false);
  reply.mockImplementationOnce(() => new Promise(() => {}));
  act(() => chat.requestReply(second, 'Blue boat'));
  const pendingSignal = reply.mock.calls[2][2];
  act(() => root.unmount()); root = createRoot(container);
  expect(pendingSignal.aborted).toBe(true);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:reference');
});

it('recovers from a reply failure independently and does not overwrite a generation error with a late reply', async () => {
  let chat!: ReturnType<typeof useBuildBuddyChat>;
  function Probe() { chat = useBuildBuddyChat('pip'); return null; }
  const reply = vi.spyOn(BuildBuddyApi, 'reply').mockRejectedValueOnce(new Error('offline'));
  await act(async () => root.render(<Probe />));
  let id!: number;
  act(() => { id = chat.startTurn('Castle', null); });
  await act(async () => chat.requestReply(id, 'Castle'));
  expect(chat.turns[0].reply).toContain('I couldn’t reply');
  expect(chat.turns[0].error).toBeUndefined();
  let respond!: (value: string) => void;
  reply.mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }));
  act(() => chat.requestReply(id, 'Castle'));
  act(() => chat.updateTurn(id, { reply: 'Please try again.', error: 'Failed to start' }));
  await act(async () => respond('Great idea!'));
  expect(chat.turns[0].reply).toBe('Please try again.');
});

it('uses authenticated backend transport for text/image chat and handles invalid or unavailable replies', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({ reply: 'A great idea!' }) } as Response);
  const signal = new AbortController().signal;
  await expect(BuildBuddyApi.reply({ pet: 'pip', prompt: 'Dragon', imageBase64: 'eA==', history: [] }, 'token', signal)).resolves.toBe('A great idea!');
  expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('/build-buddy/reply'), expect.objectContaining({
    signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
    body: JSON.stringify({ pet: 'pip', prompt: 'Dragon', image_base64: 'eA==', image_media_type: 'image/png', history: [] }),
  }));
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({ reply: '' }) } as Response);
  await expect(BuildBuddyApi.reply({ pet: 'pip', prompt: 'Dragon', history: [] }, undefined, signal)).rejects.toThrow('Empty buddy reply');
  vi.mocked(apiFetch).mockResolvedValue({ ok: false } as Response);
  await expect(BuildBuddyApi.reply({ pet: 'pip', prompt: 'Dragon', history: [] }, undefined, signal)).rejects.toThrow('unavailable');
});

it('clears conversation history and cancels old-account replies on an account change', async () => {
  let chat!: ReturnType<typeof useBuildBuddyChat>;
  function Probe({ owner }: { owner: string }) { chat = useBuildBuddyChat('pip', 'token', owner); return null; }
  let respond!: (value: string) => void;
  const reply = vi.spyOn(BuildBuddyApi, 'reply').mockImplementation(() => new Promise(resolve => { respond = resolve; }));
  await act(async () => root.render(<Probe owner="owner-one" />));
  let id!: number;
  act(() => { id = chat.startTurn('Private castle idea', null); });
  act(() => chat.requestReply(id, 'Private castle idea'));
  const signal = reply.mock.calls[0][2];
  await act(async () => root.render(<Probe owner="owner-two" />));
  expect(signal.aborted).toBe(true);
  expect(chat.turns).toEqual([]);
  await act(async () => respond('Old account reply'));
  expect(chat.turns).toEqual([]);
  act(() => { id = chat.startTurn('New idea', null); });
  act(() => chat.requestReply(id, 'New idea'));
  expect(reply.mock.calls[1][0].history).toEqual([]);
});

it('restores older active agent builds before new messages without duplicating their streams', async () => {
  const watch = vi.spyOn(LlmToBricksApiService, 'watchOutput').mockResolvedValue(true);
  await act(async () => root.render(<BuildBuddyDialogue state="idle"
    turns={[{ id: 1, text: 'Newest castle', reply: 'Great idea.', generationId: 'new', method: 'nova' }]}
    generations={[
      { id: 'new', prompt: 'Newest castle', endpoint: 'novaToBricks', status: 'processing', createdAt: '2026-10-17T13:10:00Z' },
      { id: 'old', prompt: 'Older car', endpoint: 'llmToBricks', status: 'processing', createdAt: '2026-10-17T13:00:00Z' },
    ]} />));
  const text = container.textContent!;
  expect(text.indexOf('Older car')).toBeLessThan(text.indexOf('Newest castle'));
  expect(watch.mock.calls.map(call => call[0])).toEqual(['old', 'new']);
});
