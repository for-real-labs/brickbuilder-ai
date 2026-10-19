import React, { act } from 'react';
import { readFileSync } from 'node:fs';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BuildBuddyDialogue, BUDDY_SEEN_KEY } from '../src/components/BuildBuddyDialogue';
import { PetProvider } from '../src/contexts/PetContext';
import { useBuildBuddyChat } from '../src/hooks/useBuildBuddyChat';
import { BuildBuddyApi } from '../src/services/buildBuddyApi';
import { LlmToBricksApiService } from '../src/services/llmToBricksApi';
import { GenerationEmailApi } from '../src/services/generationEmailApi';
import { apiFetch } from '../src/services/apiFetch';
import greetings from '../src/data/buddy-welcome-greetings.json';
import { formatBuddyGreeting } from '../src/utils/buddyGreetings';
const petStyles = readFileSync('src/components/PetCompanion.css', 'utf8');

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

it('shows only the current pet message and reserves opening copy for an explicit link', async () => {
  await act(async () => root.render(<PetProvider><BuildBuddyDialogue currentOnly state="building"
    turns={[{ id: 1, text: 'A car', reply: 'Older message' }, { id: 2, text: 'A boat', reply: 'Current message' }]}
    generations={[]} selectedGenerationId="building" /></PetProvider>));
  expect(container.textContent).toBe('Build buddy: Current message');
  expect(container.textContent).not.toContain('opening your build');
  await act(async () => root.render(<PetProvider><BuildBuddyDialogue currentOnly state="building"
    turns={[]} generations={[]} selectedGenerationId="linked" showOpeningMessage /></PetProvider>));
  expect(container.querySelector('[role="status"][aria-label="Build buddy is typing"]')).not.toBeNull();
  expect(container.querySelector('.pet-avatar--listening')).not.toBeNull();
  expect(container.textContent).not.toContain('I’m opening your build');
  await act(async () => root.render(<PetProvider><BuildBuddyDialogue currentOnly state="building"
    turns={[]} generations={[{ id: 'linked', prompt: 'A car', status: 'processing', endpoint: 'textTo3d' }]}
    selectedGenerationId="linked" showOpeningMessage /></PetProvider>));
  expect(container.textContent).toContain('I’m getting your build ready.');
  expect(container.querySelector('.pet-avatar--building')).not.toBeNull();
  expect(container.textContent).not.toContain('opening your build');
});

it.each([true, false])('shows a typing bubble instead of waiting copy when currentOnly is %s', async currentOnly => {
  await act(async () => root.render(<PetProvider><BuildBuddyDialogue currentOnly={currentOnly} state="listening"
    turns={[{ id: 1, text: 'A castle' }]} generations={[]} /></PetProvider>));
  const typing = container.querySelector('[role="status"][aria-label="Build buddy is typing"]');
  expect(typing?.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(3);
  expect(container.querySelector('.pet-avatar--listening')).not.toBeNull();
  expect(container.textContent).not.toContain('Let me take a look');
  await act(async () => root.render(<PetProvider><BuildBuddyDialogue currentOnly={currentOnly} state="idle"
    turns={[{ id: 1, text: 'A castle', reply: 'Let’s make a castle.' }]} generations={[]} /></PetProvider>));
  expect(container.querySelector('[aria-label="Build buddy is typing"]')).toBeNull();
  expect(container.textContent).toContain('Let’s make a castle.');
});

it('uses listening motion while typing after a reply and building motion once generation starts', async () => {
  const turn = { id: 1, text: 'A castle', reply: 'A castle sounds fun.' };
  await act(async () => root.render(<PetProvider><BuildBuddyDialogue currentOnly state="listening"
    turns={[turn]} generations={[]} /></PetProvider>));
  expect(container.querySelector('.pet-avatar--listening')).not.toBeNull();
  await act(async () => root.render(<PetProvider><BuildBuddyDialogue currentOnly state="building"
    turns={[turn]} generations={[]} /></PetProvider>));
  expect(container.querySelector('.pet-avatar--building')).not.toBeNull();
});

it('introduces Pip in a message, remembers the visit, and removes the two old captions', async () => {
  await renderDialogue();
  expect(container.textContent).toBe('Hi! I’m Pip. Tell me what to build!');
  expect(container.querySelector('[role="log"]')?.getAttribute('aria-label')).toBe('Build buddy conversation');
  expect(container.querySelector('.pet-speech-heading')).toBeNull();
  expect(container.textContent).not.toContain('Ask Pip to build something');
  expect(localStorage.getItem(BUDDY_SEEN_KEY)).toBe('true');
  // A rerender in the same visit must not turn the introduction into a welcome back.
  await renderDialogue('Jake');
  expect(container.textContent).toContain('Hi, Jake! I’m Pip');
});

it('introduces the pet on a new landing visit without requesting an AI greeting', async () => {
  localStorage.removeItem(BUDDY_SEEN_KEY);
  const welcome = vi.spyOn(BuildBuddyApi, 'welcomeGreeting');
  await act(async () => root.render(<PetProvider><BuildBuddyDialogue landingWelcome currentOnly
    turns={[]} generations={[]} state="idle" /></PetProvider>));
  expect(container.textContent).toContain('Hi! I’m Pip, your brick building buddy. What would you like to do?');
  expect(welcome).not.toHaveBeenCalled();
});

it('shows the short greeting to a returning landing visitor without requesting AI', async () => {
  localStorage.setItem(BUDDY_SEEN_KEY, 'true');
  const welcome = vi.spyOn(BuildBuddyApi, 'welcomeGreeting');
  await act(async () => root.render(<PetProvider><BuildBuddyDialogue landingWelcome currentOnly
    turns={[]} generations={[]} state="idle" username="Jake" /></PetProvider>));
  expect(container.textContent).toContain('Hi! What would you like to do?');
  expect(container.textContent).not.toContain('Jake');
  expect(welcome).not.toHaveBeenCalled();
});

it.each([undefined, 'Jake'])('welcomes a returning visitor with username %s when available', async username => {
  localStorage.setItem(BUDDY_SEEN_KEY, 'true');
  await renderDialogue(username);
  expect(greetings.map(greeting => formatBuddyGreeting(greeting, username))).toContain(container.textContent);
  const welcome = container.textContent;
  await renderDialogue(username);
  expect(container.textContent).toBe(welcome);
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
  expect(container.textContent).toContain('Hi! I’m Pip');
});

it('provides 1,000 short, open-ended invitations without offering specific objects', () => {
  expect(greetings).toHaveLength(1000);
  expect(new Set(greetings).size).toBe(1000);
  for (const greeting of greetings) {
    const invitation = greeting.split(/[.!?]\s+/).at(-1)!;
    expect(invitation).toMatch(/^(?:Tell|Show|Share|What|You (?:pick|choose)|Let me know)\b/i);
    expect(greeting).toMatch(/[?!.]$/);
    expect(greeting).not.toMatch(/[.!?]\s+Want to (?:build|make|try)\b/i);
    expect(greeting).not.toMatch(/\b(?:a|an) (?:LEGO|brick) \w+/i);
    expect(formatBuddyGreeting(greeting, ' Jake ')).toContain('Welcome back, Jake!');
    expect(formatBuddyGreeting(greeting)).toMatch(/^Welcome back!/);
    expect(formatBuddyGreeting(greeting)).not.toContain('{name}');
    expect(greeting.split(/\s+/).length).toBeLessThanOrEqual(22);
    for (const sentence of greeting.split(/[.!?]/).filter(part => part.trim())) {
      expect(sentence.trim().split(/\s+/).length).toBeLessThanOrEqual(10);
    }
    expect(greeting).not.toMatch(/imagination|creation|recreate|explore|generation|treatment/i);
  }
});

it('changes the returning greeting on the next visit even if the random value repeats', async () => {
  localStorage.setItem(BUDDY_SEEN_KEY, 'true');
  vi.spyOn(Math, 'random').mockReturnValue(0);
  await renderDialogue('Jake');
  const first = container.textContent;
  act(() => root.unmount()); root = createRoot(container);
  await renderDialogue('Jake');
  expect(container.textContent).not.toBe(first);
  expect(container.textContent).toContain('Welcome back, Jake!');
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
  expect(container.textContent).not.toContain('email');
  const dialogue = container.querySelector('[role="log"]');
  const greeting = container.querySelector('.pet-greeting')?.textContent;
  const originalPrompt = container.querySelector('.pet-chat-message--user');
  await act(async () => root.render(<BuildBuddyDialogue turns={turns} generations={[{ ...generations[0], status: 'completed' }]} state="idle" />));
  expect(container.querySelector('[role="log"]')).toBe(dialogue);
  expect(container.querySelector('.pet-greeting')?.textContent).toBe(greeting);
  expect(container.querySelector('.pet-chat-message--user')).toBe(originalPrompt);
  expect(container.textContent).toContain('Those wings will look great in bricks.');
  expect(container.textContent).toContain('Your build is ready');
  expect(container.querySelector('a')?.getAttribute('href')).toBe('/?id=job&exact=1');
  expect(container.querySelector('.pet-notification-conversation')).toBeNull();
  await act(async () => root.render(<BuildBuddyDialogue
    turns={[...turns, { id: 2, text: 'Make the wings blue', reply: 'Blue wings coming up!', generationId: 'edit', method: 'nova' }]}
    generations={[{ ...generations[0], status: 'completed' }, { ...generations[0], id: 'edit' }]} state="building" />));
  expect(container.querySelectorAll('[role="log"]')).toHaveLength(1);
  expect(container.querySelector('[role="log"]')).toBe(dialogue);
  expect(container.querySelector('.pet-chat-message--user')).toBe(originalPrompt);
  expect(container.textContent).toContain('Those wings will look great in bricks.');
  expect(container.textContent).toContain('Make the wings blue');
  expect(container.textContent).toContain('Blue wings coming up!');
});

it.each(['failed', 'cancelled'])('speaks a terminal %s build without opening another stream', async status => {
  const watch = vi.spyOn(LlmToBricksApiService, 'watchOutput');
  await act(async () => root.render(<BuildBuddyDialogue
    turns={[{ id: 1, text: 'Castle', reply: 'Great idea.', generationId: 'job', method: 'llm' }]}
    generations={[{ id: 'job', prompt: 'Castle', endpoint: 'llmToBricks', status, errorMessage: 'Internal runtime error' }]} state="idle" />));
  expect(container.textContent).toContain(status === 'failed'
    ? 'Oops! I couldn’t make your build. Please try again.' : 'I stopped this build.');
  expect(container.textContent).not.toContain('Internal runtime error');
  expect(watch).not.toHaveBeenCalled();
});

it.each(['processing', 'completed', 'cancelled', 'failed'])('keeps greetings, replies and %s updates the same size in build and edit conversations', async status => {
  vi.spyOn(LlmToBricksApiService, 'watchOutput').mockResolvedValue(true);
  const style = document.createElement('style');
  style.textContent = petStyles;
  document.head.append(style);
  const dimensions = (element: Element, properties: string[]) => {
    const computed = getComputedStyle(element);
    return properties.map(property => computed.getPropertyValue(property));
  };
  try {
    for (const text of ['Giraffe', 'Give the giraffe blue spots']) {
      await act(async () => root.render(<BuildBuddyDialogue state="idle"
        turns={[{ id: 1, text, reply: 'A spotted giraffe sounds great!', generationId: 'job', method: 'llm' }]}
        generations={[{ id: 'job', prompt: 'Giraffe', endpoint: 'llmToBricks', status }]} />));
      const greeting = container.querySelector('.pet-greeting')!;
      const bubbleProperties = ['padding', 'font-size', 'line-height', 'border-radius', 'max-width', 'flex-grow'];
      const expectedBubble = dimensions(greeting.querySelector('.pet-speech')!, bubbleProperties);
      const expectedAvatar = dimensions(greeting.querySelector('.pet-avatar')!, ['width', 'height', 'margin-left']);
      const messages = container.querySelectorAll('.pet-chat-message:not(.pet-chat-message--user)');
      expect(messages.length).toBeGreaterThanOrEqual(2);
      for (const message of messages) {
        expect(dimensions(message.querySelector('.pet-chat-bubble')!, bubbleProperties)).toEqual(expectedBubble);
        expect(dimensions(message.querySelector('.pet-avatar')!, ['width', 'height', 'margin-left'])).toEqual(expectedAvatar);
      }
      const current = container.querySelector('[data-current-buddy-message]')!;
      expect(current).toBe(messages[messages.length - 1]);
      expect(container.querySelectorAll('[data-current-buddy-message]')).toHaveLength(1);
      expect(current.querySelector('.pet-avatar')).not.toBeNull();
      const currentAvatar = getComputedStyle(current.querySelector('.pet-avatar')!);
      expect(currentAvatar.bottom).toBe('0px');
      expect(currentAvatar.top).toBe('auto');
      expect(currentAvatar.height).toBe('var(--buddy-height)');
      expect(getComputedStyle(container.querySelector('.pet-chat-message--user .pet-chat-bubble')!).flexGrow).not.toBe('1');
    }
  } finally {
    style.remove();
  }
});

it('starts a fresh dialogue after reload instead of restoring the previous conversation', async () => {
  let chat!: ReturnType<typeof useBuildBuddyChat>;
  function Conversation() {
    chat = useBuildBuddyChat('pip');
    return <BuildBuddyDialogue turns={chat.turns} generations={[]} state="idle" />;
  }
  await act(async () => root.render(<Conversation />));
  act(() => {
    const id = chat.startTurn('Yesterday’s private castle', null);
    chat.updateTurn(id, { reply: 'Let’s build that castle.' });
  });
  expect(container.textContent).toContain('Yesterday’s private castle');
  act(() => root.unmount()); root = createRoot(container);
  await act(async () => root.render(<Conversation />));
  expect(chat.turns).toEqual([]);
  expect(container.textContent).not.toContain('Yesterday’s private castle');
  expect(container.textContent).toContain('Welcome back!');
});

it('clears the current conversation when starting a new build', async () => {
  let chat!: ReturnType<typeof useBuildBuddyChat>;
  function Conversation() {
    chat = useBuildBuddyChat('pip');
    return <BuildBuddyDialogue turns={chat.turns} generations={[]} state="idle" welcomeMessage="What would you like to do?" />;
  }
  await act(async () => root.render(<Conversation />));
  act(() => {
    const id = chat.startTurn('An old castle', null);
    chat.updateTurn(id, { reply: 'Let’s build it.' });
  });
  expect(container.textContent).toContain('An old castle');
  act(() => chat.resetConversation());
  expect(chat.turns).toEqual([]);
  expect(container.textContent).toContain('What would you like to do?');
  expect(container.textContent).not.toContain('An old castle');
});

it.each([undefined, 'job'])('shows one pet failure message without infrastructure details for generation %s', async generationId => {
  const watch = vi.spyOn(LlmToBricksApiService, 'watchOutput');
  await act(async () => root.render(<BuildBuddyDialogue
    turns={[{ id: 1, text: 'A cat', reply: 'Let’s give your idea another try.',
      error: 'Cannot reach the Nova runtime. Check the private connection.', generationId, method: 'nova' }]}
    generations={generationId ? [{ id: generationId, prompt: 'A cat', endpoint: 'novaToBricks', status: 'failed' }] : []}
    state="idle" />));
  const message = container.querySelector('[role="status"]');
  expect(message?.textContent).toBe('Oops! I couldn’t make your build. Please try again.');
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
  expect(chat.turns[0].reply).toContain('I can’t chat right now');
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

it('gets bounded OpenAI build ideas through the buddy API and validates the response', async () => {
  const signal = new AbortController().signal;
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({ idea: '  a Pikachu riding a skateboard  ' }) } as Response);
  await expect(BuildBuddyApi.randomIdea(['a dragon'], 'token', signal)).resolves.toBe('a Pikachu riding a skateboard');
  expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('/build-buddy/random-idea'), expect.objectContaining({
    method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
    body: JSON.stringify({ previous_ideas: ['a dragon'] }),
  }));
  for (const idea of ['', 42, 'x'.repeat(121)]) {
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({ idea }) } as Response);
    await expect(BuildBuddyApi.randomIdea([], undefined, signal)).rejects.toThrow('Invalid build idea');
  }
  vi.mocked(apiFetch).mockResolvedValue({ ok: false } as Response);
  await expect(BuildBuddyApi.randomIdea([], undefined, signal)).rejects.toThrow('unavailable');
});

it('requests a bounded AI welcome without sending the visitor name', async () => {
  const signal = new AbortController().signal;
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({ greeting: '  Glad you’re here to make something fun.  ' }) } as Response);
  await expect(BuildBuddyApi.welcomeGreeting('pip', 'token', signal)).resolves.toBe('Glad you’re here to make something fun.');
  expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('/build-buddy/welcome-greeting'), expect.objectContaining({
    method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
    body: JSON.stringify({ pet: 'pip', previous_greetings: [] }),
  }));
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({ greeting: 'x'.repeat(121) }) } as Response);
  await expect(BuildBuddyApi.welcomeGreeting('pip', undefined, signal)).rejects.toThrow('Invalid welcome greeting');
});

it('sends intent detection through the authenticated backend and rejects uncertain or invalid actions', async () => {
  const signal = new AbortController().signal;
  const request = { prompt: 'castle', hasImage: false, history: [] };
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({ intent: 'generate', confidence: 0.95 }) } as Response);
  await expect(BuildBuddyApi.classify(request, 'token', signal)).resolves.toEqual({ intent: 'generate', confidence: 0.95 });
  expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('/build-buddy/intent'), expect.objectContaining({
    signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
    body: JSON.stringify({ prompt: 'castle', history: [], has_image: false, gift_planning: false }),
  }));
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({ intent: 'generate', confidence: 0.2 }) } as Response);
  await expect(BuildBuddyApi.classify(request, undefined, signal)).resolves.toEqual({ intent: 'clarify', confidence: 0.2 });
  for (const response of [{ intent: 'delete', confidence: 1 }, { intent: 'generate', confidence: -1 }, { intent: 'generate' }]) {
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => response } as Response);
    await expect(BuildBuddyApi.classify(request, undefined, signal)).rejects.toThrow('Invalid message routing');
  }
});

it('cancels pending routing on an account change without acting on an old-owner decision', async () => {
  let chat!: ReturnType<typeof useBuildBuddyChat>;
  function Probe({ owner }: { owner: string }) { chat = useBuildBuddyChat('pip', owner, owner); return null; }
  let respond!: (value: { intent: 'generate'; confidence: number }) => void;
  const classify = vi.spyOn(BuildBuddyApi, 'classify').mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }));
  await act(async () => root.render(<Probe owner="one" />));
  let pending!: ReturnType<typeof chat.routeMessage>;
  act(() => { pending = chat.routeMessage('Private castle', null); });
  expect(chat.routing).toBe(true);
  const signal = classify.mock.calls[0][2];
  await act(async () => root.render(<Probe owner="two" />));
  expect(signal.aborted).toBe(true);
  expect(chat.routing).toBe(false);
  await act(async () => respond({ intent: 'generate', confidence: 1 }));
  await expect(pending).resolves.toBeUndefined();
  expect(chat.turns).toEqual([]);
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

it('keeps older builds out of a fresh conversation and streams only current turns', async () => {
  const watch = vi.spyOn(LlmToBricksApiService, 'watchOutput').mockResolvedValue(true);
  await act(async () => root.render(<BuildBuddyDialogue state="idle"
    turns={[{ id: 1, text: 'Newest castle', reply: 'Great idea.', generationId: 'new', method: 'nova' }]}
    generations={[
      { id: 'new', prompt: 'Newest castle', endpoint: 'novaToBricks', status: 'processing', createdAt: '2026-10-17T13:10:00Z' },
      { id: 'old', prompt: 'Older car', endpoint: 'llmToBricks', status: 'processing', createdAt: '2026-10-17T13:00:00Z' },
    ]} />));
  const text = container.textContent!;
  expect(text).not.toContain('Older car');
  expect(text).toContain('Newest castle');
  expect(watch.mock.calls.map(call => call[0])).toEqual(['new']);
});

it.each(['failed', 'cancelled', 'processing'])('does not rebuild a prior %s job as chat history on a fresh visit', async status => {
  const watch = vi.spyOn(LlmToBricksApiService, 'watchOutput').mockResolvedValue(true);
  await act(async () => root.render(<BuildBuddyDialogue state="idle" turns={[]}
    generations={[{ id: 'old', prompt: 'Old concert stage', endpoint: 'novaToBricks', status }]} />));
  expect(container.querySelector('.pet-chat-message--user')).toBeNull();
  expect(container.textContent).not.toContain('Old concert stage');
  expect(container.textContent).not.toContain('Oops!');
  expect(watch).not.toHaveBeenCalled();
});

it('shows progress only for the explicitly selected build when returning from a model link', async () => {
  const watch = vi.spyOn(LlmToBricksApiService, 'watchOutput').mockResolvedValue(true);
  await act(async () => root.render(<BuildBuddyDialogue state="building" turns={[]} selectedGenerationId="selected"
    generations={[
      { id: 'old', prompt: 'Old concert stage', endpoint: 'novaToBricks', status: 'failed' },
      { id: 'selected', prompt: 'Selected castle', endpoint: 'novaToBricks', status: 'processing' },
    ]} />));
  expect(container.textContent).toContain('Selected castle');
  expect(container.textContent).not.toContain('Old concert stage');
  expect(watch.mock.calls.map(call => call[0])).toEqual(['selected']);
});

it('sends gift mode through authenticated transport and only accepts a usable build prompt', async () => {
  const signal = new AbortController().signal;
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({ reply: 'Who is it for?', build_prompt: null }) } as Response);
  await expect(BuildBuddyApi.planGift({ pet: 'nib', prompt: 'Gift idea?', history: [] }, 'token', signal)).resolves.toEqual({ reply: 'Who is it for?', buildPrompt: undefined });
  expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('/build-buddy/reply'), expect.objectContaining({
    signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
    body: JSON.stringify({ pet: 'nib', prompt: 'Gift idea?', history: [], mode: 'gift' }),
  }));
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({ reply: 'A garden!', build_prompt: ' A LEGO garden ' }) } as Response);
  await expect(BuildBuddyApi.planGift({ pet: 'nib', prompt: 'Flowers', history: [] }, undefined, signal)).resolves.toEqual({ reply: 'A garden!', buildPrompt: 'A LEGO garden' });
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({ reply: '' }) } as Response);
  await expect(BuildBuddyApi.planGift({ pet: 'nib', prompt: 'Gift', history: [] }, undefined, signal)).rejects.toThrow('Empty buddy reply');
});

it('aborts pending gift replies on an account change and keeps the previous owner’s gift private', async () => {
  let chat!: ReturnType<typeof useBuildBuddyChat>;
  function Probe({ owner }: { owner: string }) { chat = useBuildBuddyChat('pip', 'token', owner); return null; }
  let respond!: (value: { reply: string; buildPrompt: string }) => void;
  const plan = vi.spyOn(BuildBuddyApi, 'planGift').mockImplementationOnce(() => new Promise(resolve => { respond = resolve; })).mockResolvedValue({ reply: 'Who is it for?' });
  await act(async () => root.render(<Probe owner="one" />));
  let id!: number;
  act(() => { id = chat.startTurn('A private gift idea', null, 'gift'); });
  act(() => { void chat.requestGiftReply(id, 'A private gift idea', true); });
  const signal = plan.mock.calls[0][2];
  await act(async () => root.render(<Probe owner="two" />));
  expect(signal.aborted).toBe(true);
  await act(async () => respond({ reply: 'Old gift', buildPrompt: 'Old private gift prompt' }));
  expect(chat.turns).toEqual([]);
  act(() => { id = chat.startTurn('Gift', null, 'gift'); });
  await act(async () => chat.requestGiftReply(id, 'Gift', true));
  expect(plan.mock.calls[1][0].history).toEqual([]);
});

it('uses one animated model message, keeps it stable, and varies it on the next visit', async () => {
  localStorage.setItem(BUDDY_SEEN_KEY, 'true');
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const renderModel = () => act(async () => root.render(<BuildBuddyDialogue turns={[]} generations={[]}
    state="idle" username="Jake" selectedGenerationId="castle" model={{ id: 'castle', orderable: true }} />));
  await renderModel();
  const first = container.textContent;
  expect(first).toContain('edit');
  expect(first).toContain('order button');
  expect(first).toContain('delivered');
  expect(first).not.toContain('Welcome back');
  expect(container.querySelectorAll('.pet-greeting')).toHaveLength(1);
  expect(container.querySelector('.pet-response-word')).not.toBeNull();
  expect(container.querySelector('button')).toBeNull();
  await renderModel();
  expect(container.textContent).toBe(first);
  act(() => root.unmount()); root = createRoot(container);
  await renderModel();
  expect(container.textContent).not.toBe(first);
});

it('keeps image and gift replies free of suggestion buttons', async () => {
  await act(async () => root.render(<BuildBuddyDialogue state="idle" generations={[]} turns={[
    { id: 1, text: 'Use a photo', kind: 'upload', reply: 'Upload your photo below.' },
    { id: 2, text: 'Find a gift', kind: 'gift', reply: 'A little castle!', buildPrompt: 'A little castle' },
  ]} />));
  expect(container.querySelector('.pet-chat-action')).toBeNull();
});


it('clears earlier chat when a model opens, keeps new edits visible, and clears them for the next ready model', async () => {
  const earlier = { id: 1, text: 'An earlier idea', reply: 'An earlier reply' };
  const edit = { id: 2, text: 'Add a drawbridge', reply: 'I’m making your changes.' };
  const render = (id: string, turns: typeof earlier[]) => act(async () => root.render(<BuildBuddyDialogue
    state="idle" generations={[]} turns={turns} selectedGenerationId={id} model={{ id, orderable: true }} />));
  await render('castle', [earlier]);
  expect(container.textContent).not.toContain('An earlier');
  await render('castle', [earlier, edit]);
  expect(container.textContent).toContain('Add a drawbridge');
  expect(container.textContent).toContain('I’m making your changes.');
  await render('castle-edited', [earlier, edit]);
  expect(container.textContent).not.toContain('Add a drawbridge');
  expect(container.querySelectorAll('.pet-greeting')).toHaveLength(1);
});

it('shows a subject fact above the edit invitation in a separate bubble', async () => {
  const greet = vi.spyOn(BuildBuddyApi, 'modelGreeting').mockResolvedValue('Fun fact: Troy stood in modern Turkey!');
  await act(async () => root.render(<BuildBuddyDialogue turns={[]} generations={[]} state="idle"
    model={{ id: 'castle', name: 'City of Troy', orderable: true }} />));
  expect(greet).toHaveBeenCalledWith({ generationId: 'castle', pet: 'pip', previousFacts: [] }, undefined, expect.any(AbortSignal));
  expect(container.textContent).toContain('Fun fact: Troy stood in modern Turkey!');
  expect(container.querySelectorAll('.pet-greeting')).toHaveLength(1);
  const bubbles = container.querySelectorAll('.pet-model-greeting .pet-chat-bubble, .pet-model-greeting .pet-speech');
  expect(bubbles).toHaveLength(2);
  expect(bubbles[0].textContent).toContain('Fun fact: Troy stood in modern Turkey!');
  expect(bubbles[0].textContent).not.toContain('order button');
  expect(bubbles[1].textContent).toContain('order button');
  const strong = Array.from(container.querySelectorAll('strong'));
  expect(strong.map(el => el.textContent)).toEqual(['edit', 'order']);
  expect(strong.every(el => el.querySelector('.pet-response-word'))).toBe(true);
  expect(container.querySelector('.pet-response-word')?.textContent).toBe('Fun');
});

it('ignores late facts after switching models and cancels the old request', async () => {
  let finish!: (text: string) => void;
  const greet = vi.spyOn(BuildBuddyApi, 'modelGreeting').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce('Fun fact: rovers can explore the Moon without astronauts aboard!');
  const render = (id: string, name: string) => act(async () => root.render(<BuildBuddyDialogue turns={[]} generations={[]}
    state="idle" model={{ id, name, orderable: true }} />));
  await render('castle', 'City of Troy');
  await render('rover', 'Moon Rover');
  expect(greet.mock.calls[0][2].aborted).toBe(true);
  await act(async () => finish('Fun fact: old castle fact'));
  expect(container.textContent).toContain('Fun fact: rovers can explore');
  expect(container.textContent).not.toContain('Old castle');
});

it('sends previously shown facts when reopening the same model', async () => {
  const greet = vi.spyOn(BuildBuddyApi, 'modelGreeting').mockResolvedValueOnce('Did you know Troy stood in modern Turkey?')
    .mockResolvedValueOnce('Fun fact: other models are different!')
    .mockResolvedValueOnce('Fun fact: Troy had strong city walls!');
  const render = (id: string) => act(async () => root.render(<BuildBuddyDialogue turns={[]} generations={[]}
    state="idle" model={{ id, name: 'City of Troy', orderable: true }} />));
  await render('castle');
  await render('other');
  await render('castle');
  expect(greet).toHaveBeenLastCalledWith({ generationId: 'castle', pet: 'pip',
    previousFacts: ['Did you know Troy stood in modern Turkey?'] }, undefined, expect.any(AbortSignal));
});

it('falls back to the actual name without inventing image details if a greeting fails', async () => {
  vi.spyOn(BuildBuddyApi, 'modelGreeting').mockRejectedValue(new Error('Unavailable'));
  await act(async () => root.render(<BuildBuddyDialogue turns={[]} generations={[]} state="idle"
    model={{ id: 'castle', name: 'City of Troy', orderable: true }} />));
  expect(container.textContent).toContain('Here’s City of Troy!');
  expect(container.textContent).not.toContain('fun build');
  expect(Array.from(container.querySelectorAll('strong')).map(el => el.textContent)).toEqual(['edit', 'order']);
});

it('ends a stalled model greeting with a name-based fallback', async () => {
  vi.useFakeTimers();
  const greet = vi.spyOn(BuildBuddyApi, 'modelGreeting').mockImplementation(() => new Promise(() => {}));
  try {
    await act(async () => root.render(<BuildBuddyDialogue turns={[]} generations={[]} state="idle"
      model={{ id: 'castle', name: 'City of Troy', orderable: true }} />));
    expect(container.querySelector('[role="status"][aria-label="Build buddy is typing"]')).not.toBeNull();
    expect(container.querySelector('.pet-avatar--listening')).not.toBeNull();
    expect(container.textContent).not.toContain('I’m looking at City of Troy');
    await act(async () => vi.advanceTimersByTimeAsync(22000));
    expect(greet.mock.calls[0][2].aborted).toBe(true);
    expect(container.textContent).toContain('Here’s City of Troy!');
    expect(container.querySelector('[aria-label="Build buddy is typing"]')).toBeNull();
  } finally { vi.useRealTimers(); }
});

it('requests model greetings by id without accepting client-supplied image URLs or names', async () => {
  const signal = new AbortController().signal;
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({ reply: 'Fun fact: Troy stood in modern Turkey!' }) } as Response);
  await expect(BuildBuddyApi.modelGreeting({ generationId: 'castle', pet: 'pip' }, 'token', signal))
    .resolves.toBe('Fun fact: Troy stood in modern Turkey!');
  expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('/build-buddy/model-greeting'), expect.objectContaining({
    method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer token' }), signal,
    body: JSON.stringify({ generation_id: 'castle', pet: 'pip', previous_facts: [] }),
  }));
});

it.each([{ ok: false }, { ok: true, reply: '' }, { ok: true, reply: 42 }])('rejects unavailable or invalid model greetings: %o', async result => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: result.ok, json: async () => ({ reply: result.reply }) } as Response);
  await expect(BuildBuddyApi.modelGreeting({ generationId: 'castle', pet: 'pip' }, undefined, new AbortController().signal)).rejects.toThrow();
});

it.each(['export', 'export_ldraw', 'export_io', 'export_csv', 'export_xml', 'import', 'import_ldraw', 'import_io',
  'convert_image', 'convert_glb', 'convert_obj', 'generation_settings', 'buddy_settings', 'community', 'github', 'feedback', 'support'])('accepts the %s tool intent only with sufficient confidence', async intent => {
  const request = { prompt: 'Use the tool', history: [], hasImage: false };
  const signal = new AbortController().signal;
  vi.mocked(apiFetch).mockResolvedValueOnce({ ok: true, json: async () => ({ intent, confidence: 0.95 }) } as Response);
  await expect(BuildBuddyApi.classify(request, undefined, signal)).resolves.toEqual({ intent, confidence: 0.95 });
  vi.mocked(apiFetch).mockResolvedValueOnce({ ok: true, json: async () => ({ intent, confidence: 0.7 }) } as Response);
  await expect(BuildBuddyApi.classify(request, undefined, signal)).resolves.toEqual({ intent: 'clarify', confidence: 0.7 });
});
