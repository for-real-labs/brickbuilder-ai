import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { BuildBuddyApi } from '../services/buildBuddyApi';
import { usePet } from '../contexts/PetContext';
import { type PetState } from '../pets';
import { PetChatMessage, PetPromptGreeting, PetTypingIndicator } from './PetCompanion';
import { LlmGenerationOutput } from './LlmGenerationOutput';
import { type BuddyTurn } from '../hooks/useBuildBuddyChat';
import { type GenerationActivity, isGenerationActive } from '../hooks/useGenerationActivity';
import { isAgentGeneration } from '../utils/agentGeneration';
import { BUILD_FAILURE_MESSAGE } from '../utils/buildProgress';
import { BuddyCompletedBuilds } from './BuddyCompletedBuilds';
import { GenerationElapsedTime } from './GenerationElapsedTime';
import { MODEL_EDIT_INVITATION } from '../utils/buddyModelGreetings';
import { recentModelFacts, rememberModelFact } from '../utils/buddyModelFacts';
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
  const [fact, setFact] = useState<string | null>(null);
  const name = model.name?.trim().slice(0, 200) || 'your model';
  useEffect(() => {
    const controller = new AbortController();
    const fallback = `Here’s ${name}!`;
    const timeout = setTimeout(() => { controller.abort(); setFact(fallback); }, 22000);
    void BuildBuddyApi.modelGreeting({ generationId: model.id, pet: pet.id, previousFacts: recentModelFacts(model.id) },
      session?.access_token, controller.signal)
      .then(reply => { if (!controller.signal.aborted) { rememberModelFact(model.id, reply); setFact(reply); } })
      .catch(() => { if (!controller.signal.aborted) setFact(fallback); })
      .finally(() => clearTimeout(timeout));
    return () => { controller.abort(); clearTimeout(timeout); };
  }, [model.id, name, pet.id, session?.access_token]);
  const action = model.orderable ? MODEL_EDIT_INVITATION : 'Tell me if you want to edit this model!';
  return <div className="pet-dialogue-turn pet-model-greeting">
    <PetChatMessage state={fact ? state : 'listening'}><p>{fact || <PetTypingIndicator />}</p></PetChatMessage>
    {fact && <PetPromptGreeting state={state} showPetSwitch={false}>{emphasizeModelActions(action)}</PetPromptGreeting>}
  </div>;
}

export function BuildBuddyDialogue({ turns, generations, state, username, authLoading = false, onViewGeneration, selectedGenerationId, model, reasoningOnly = false, currentOnly = false, showOpeningMessage = false, currentMessage, welcomeMessage, landingWelcome = false, welcomeActions, onBackToWelcome, children }: {
  turns: BuddyTurn[]; generations: GenerationActivity[]; state: PetState; username?: string | null; authLoading?: boolean;
  onViewGeneration?: (id: string) => void;
  selectedGenerationId?: string | null;
  model?: DialogueModel | null;
  reasoningOnly?: boolean;
  currentOnly?: boolean;
  showOpeningMessage?: boolean;
  currentMessage?: React.ReactNode | ((greeting: string) => React.ReactNode);
  welcomeMessage?: string;
  landingWelcome?: boolean;
  welcomeActions?: React.ReactNode;
  onBackToWelcome?: () => void;
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
  const pinModelGreeting = Boolean(model && visibleTurns.length === 0 && !reasoningOnly && !currentMessage);
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
    if (model && visibleTurns.length === 1) follow.current = true;
    const scroll = () => {
      if (pinModelGreeting) { element.scrollTop = 0; return; }
      if (follow.current) element.scrollTop = element.scrollHeight;
    };
    scroll();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scroll);
    if (element.firstElementChild) observer?.observe(element.firstElementChild);
    return () => observer?.disconnect();
  }, [turns.length, generations.length, model?.id, pinModelGreeting, visibleTurns.length]);
  const restored = model ? [] : generations.filter(row => row.id === selectedGenerationId && isAgentGeneration(row.endpoint)
    && !turns.some(turn => turn.generationId === row.id));
  const latestTurn = visibleTurns.at(-1);
  const activeGeneration = generations.find(row => isGenerationActive(row.status)
    && (row.id === latestTurn?.generationId || row.id === selectedGenerationId));
  const greeting = returning ? formatBuddyGreeting(welcome, greetingName)
    : `Hi${greetingName ? `, ${greetingName}!` : '!'} I’m ${pet.name}. Tell me what to build!`;
  const landingGreeting = returning ? 'Hi! What would you like to do?'
    : `Hi! I’m ${pet.name}, your brick building buddy. What would you like to do?`;
  const buildsGreeting = returning ? `Welcome back${greetingName ? `, ${greetingName}` : ''}!`
    : `Hi${greetingName ? `, ${greetingName}` : ''}! I’m ${pet.name}.`;
  const resolvedCurrentMessage = typeof currentMessage === 'function' ? currentMessage(buildsGreeting) : currentMessage;
  const currentDialogue = resolvedCurrentMessage ?? (activeGeneration && isAgentGeneration(activeGeneration.endpoint)
    ? <div key={activeGeneration.id}><BuddyBuildMessages generationId={activeGeneration.id} status={activeGeneration.status} />
      <GenerationElapsedTime startedAt={activeGeneration.createdAt} /></div>
    : activeGeneration ? <PetChatMessage state="building"><p>I’m getting your build ready.</p>
      <GenerationElapsedTime startedAt={activeGeneration.createdAt} /></PetChatMessage>
    : latestTurn ? <PetChatMessage state={state === 'building' ? 'building' : state === 'listening' || !latestTurn.reply ? 'listening' : 'idle'}>
      {latestTurn.error ? <p role="status">{BUILD_FAILURE_MESSAGE}</p>
        : latestTurn.reply ? <p>{latestTurn.reply}</p> : <PetTypingIndicator />}
      {onBackToWelcome && <div className="pet-chat-actions">
        <button type="button" className="pet-chat-action" onClick={onBackToWelcome}>Go back</button>
      </div>}
    </PetChatMessage>
    : model && !reasoningOnly ? <ModelGreeting key={model.id} state={state} model={model} />
    : showOpeningMessage && selectedGenerationId ? <PetPromptGreeting state="listening" showPetSwitch={false}><PetTypingIndicator /></PetPromptGreeting>
    : <PetPromptGreeting state={state} showPetSwitch={false} actions={welcomeActions}>
      {landingWelcome ? landingGreeting : welcomeMessage ?? greeting}
    </PetPromptGreeting>);
  return <div ref={log} className="pet-dialogue" role="log" aria-label="Build buddy conversation" aria-live="polite" aria-relevant="additions text"
    onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64; }}>
    <div className="pet-dialogue-content">
      {currentOnly ? currentDialogue : <>
      {children}
      {reasoningOnly ? null : model ? <ModelGreeting key={model.id} state={state} model={model} />
        : selectedGenerationId ? <PetPromptGreeting state="listening" showPetSwitch={false}><PetTypingIndicator /></PetPromptGreeting>
        : <PetPromptGreeting state={state} showPetSwitch={false}>
        {landingWelcome ? landingGreeting : welcomeMessage ?? greeting}
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
              {turn.reply ? <p>{turn.reply}</p> : <PetTypingIndicator />}
            </PetChatMessage>}
          {!turn.error && turn.generationId && (turn.method === 'llm' || turn.method === 'nova') && <BuddyBuildMessages
            generationId={turn.generationId} status={generation?.status || 'started'} />}
        </div>;
      })}
      </>}
    </div>
  </div>;
}
