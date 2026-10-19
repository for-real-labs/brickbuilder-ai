import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { BuildBuddyApi } from '../services/buildBuddyApi';
import { usePet } from '../contexts/PetContext';
import { type PetState } from '../pets';
import { PetChatMessage, PetPromptGreeting } from './PetCompanion';
import { LlmGenerationOutput } from './LlmGenerationOutput';
import { type BuddyTurn } from '../hooks/useBuildBuddyChat';
import { type GenerationActivity, isGenerationActive } from '../hooks/useGenerationActivity';
import { isAgentGeneration } from '../utils/agentGeneration';
import { BUILD_FAILURE_MESSAGE } from '../utils/buildProgress';
import { BuddyCompletedBuilds } from './BuddyCompletedBuilds';
import { pickModelGreeting, rememberModelGreeting } from '../utils/buddyModelGreetings';
import { formatBuddyGreeting, pickBuddyGreeting, rememberBuddyGreeting } from '../utils/buddyGreetings';

export const BUDDY_SEEN_KEY = 'brickbuilder.build-buddy-seen';

export function BuddyBuildMessages({ generationId, status }: { generationId: string; status: string }) {
  const active = isGenerationActive(status);
  return <div className="pet-build-messages">
    <LlmGenerationOutput generationId={generationId} active={active} status={status} />
  </div>;
}

interface DialogueModel { id: string; name?: string | null; orderable: boolean }

/** Keep the actual action words bold without interpreting model text as markup. */
function emphasizeModelActions(text: string) {
  return text.split(/(\b(?:edit|order)\b)/gi).map((part, index) => /^(edit|order)$/i.test(part)
    ? <strong className="font-bold" key={index}>{part}</strong> : part);
}

function ModelGreeting({ state, model }: { state: PetState; model: DialogueModel }) {
  const { pet } = usePet();
  const { session } = useAuth();
  const [invitation] = useState(pickModelGreeting);
  const [compliment, setCompliment] = useState<string | null>(null);
  const name = model.name?.trim().slice(0, 200) || 'your model';
  useEffect(() => { rememberModelGreeting(invitation); }, [invitation]);
  useEffect(() => {
    const controller = new AbortController();
    const fallback = `Here’s ${name}!`;
    const timeout = setTimeout(() => { controller.abort(); setCompliment(fallback); }, 22000);
    void BuildBuddyApi.modelGreeting({ generationId: model.id, pet: pet.id }, session?.access_token, controller.signal)
      .then(reply => { if (!controller.signal.aborted) setCompliment(reply); })
      .catch(() => { if (!controller.signal.aborted) setCompliment(fallback); })
      .finally(() => clearTimeout(timeout));
    return () => { controller.abort(); clearTimeout(timeout); };
  }, [model.id, name, pet.id, session?.access_token]);
  const action = model.orderable ? invitation : 'Tell me if you want to edit this model!';
  return <PetPromptGreeting state={state} showPetSwitch={false}>
    {emphasizeModelActions(`${compliment || `I’m looking at ${name}…`} ${action}`)}
  </PetPromptGreeting>;
}

export function BuildBuddyDialogue({ turns, generations, state, username, authLoading = false, onViewGeneration, selectedGenerationId, model, reasoningOnly = false, children }: {
  turns: BuddyTurn[]; generations: GenerationActivity[]; state: PetState; username?: string | null; authLoading?: boolean;
  onViewGeneration?: (id: string) => void;
  selectedGenerationId?: string | null;
  model?: DialogueModel | null;
  reasoningOnly?: boolean;
  children?: React.ReactNode;
}) {
  const { pet } = usePet();
  // A ready model starts a fresh conversation; keep only edits made after it opens.
  const [modelConversation, setModelConversation] = useState({ id: model?.id, start: model ? turns.length : 0 });
  if (modelConversation.id !== model?.id) {
    setModelConversation({ id: model?.id, start: model ? turns.length : 0 });
  }
  const visibleTurns = model ? turns.slice(modelConversation.start) : turns;
  const [returning] = useState(() => {
    try { return localStorage.getItem(BUDDY_SEEN_KEY) === 'true'; } catch { return false; }
  });
  const [welcome] = useState(pickBuddyGreeting);
  const greetingName = !authLoading && typeof username === 'string' ? username.trim().slice(0, 80) : '';
  useEffect(() => {
    try { localStorage.setItem(BUDDY_SEEN_KEY, 'true'); } catch { /* Chat also works without storage. */ }
    if (returning) rememberBuddyGreeting(welcome);
  }, [returning, welcome]);
  const log = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    const element = log.current;
    if (!element) return;
    // Stream and email prompts can append nested messages independently of turns.
    const updateSpeaker = () => {
      const messages = element.querySelectorAll<HTMLElement>('.pet-greeting, .pet-chat-message:not(.pet-chat-message--user)');
      element.querySelectorAll('[data-current-buddy-message]').forEach(message => message.removeAttribute('data-current-buddy-message'));
      messages[messages.length - 1]?.setAttribute('data-current-buddy-message', 'true');
    };
    updateSpeaker();
    const observer = new MutationObserver(updateSpeaker);
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = log.current;
    if (!element) return;
    const scroll = () => { if (follow.current) element.scrollTop = element.scrollHeight; };
    scroll();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scroll);
    if (element.firstElementChild) observer?.observe(element.firstElementChild);
    return () => observer?.disconnect();
  }, [turns.length, generations.length]);
  const restored = model ? [] : generations.filter(row => row.id === selectedGenerationId && isAgentGeneration(row.endpoint)
    && !turns.some(turn => turn.generationId === row.id));
  return <div ref={log} className="pet-dialogue" role="log" aria-label="Build buddy conversation" aria-live="polite" aria-relevant="additions text"
    onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64; }}>
    <div className="pet-dialogue-content">
      {children}
      {reasoningOnly ? null : model ? <ModelGreeting key={model.id} state={state} model={model} />
        : selectedGenerationId ? <PetPromptGreeting state={state} showPetSwitch={false}>I’m opening your build…</PetPromptGreeting>
        : <PetPromptGreeting state={state} showPetSwitch={false}>
        {returning ? formatBuddyGreeting(welcome, greetingName)
          : `Hi${greetingName ? `, ${greetingName}!` : '!'} I’m ${pet.name}. Tell me what to build!`}
      </PetPromptGreeting>}
      {!selectedGenerationId && !model && <BuddyCompletedBuilds onView={onViewGeneration} />}
      {restored.map(row => <div key={row.id} className="pet-dialogue-turn">
        <PetChatMessage user><p>{row.prompt || 'Image reference'}</p></PetChatMessage>
        <BuddyBuildMessages generationId={row.id} status={row.status} />
      </div>)}
      {visibleTurns.map(turn => {
        const generation = generations.find(row => row.id === turn.generationId);
        return <div key={turn.id} className="pet-dialogue-turn">
          <PetChatMessage user>
            {turn.imageUrl && <img className="pet-chat-reference" src={turn.imageUrl} alt={turn.imageName || 'Your reference image'} />}
            {turn.text && <p>{turn.text}</p>}
            {!turn.text && <p>{turn.imageName || 'Image reference'}</p>}
          </PetChatMessage>
          {turn.error ? <PetChatMessage><p role="status">{BUILD_FAILURE_MESSAGE}</p></PetChatMessage>
            : <PetChatMessage state={turn.reply ? 'idle' : 'listening'}>
              <p>{turn.reply || (turn.kind === 'gift' ? 'Let’s find a gift they’ll love…' : 'Let me take a look…')}</p>
            </PetChatMessage>}
          {!turn.error && turn.generationId && (turn.method === 'llm' || turn.method === 'nova') && <BuddyBuildMessages
            generationId={turn.generationId} status={generation?.status || 'started'} />}
        </div>;
      })}
    </div>
  </div>;
}
