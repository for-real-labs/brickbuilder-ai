import React, { useEffect, useRef, useState } from 'react';
import { usePet } from '../contexts/PetContext';
import { type PetState } from '../pets';
import { PetChatMessage, PetPromptGreeting } from './PetCompanion';
import { LlmGenerationOutput } from './LlmGenerationOutput';
import { GetNotifiedButton } from './GetNotifiedButton';
import { type BuddyTurn } from '../hooks/useBuildBuddyChat';
import { type GenerationActivity, isGenerationActive } from '../hooks/useGenerationActivity';
import { isAgentGeneration } from '../utils/agentGeneration';

export const BUDDY_SEEN_KEY = 'brickbuilder.build-buddy-seen';

export function BuddyBuildMessages({ generationId, status, error }: { generationId: string; status: string; error?: string }) {
  const active = isGenerationActive(status);
  return <div className="pet-build-messages">
    <LlmGenerationOutput generationId={generationId} active={active} status={status} error={error} />
    {active && <GetNotifiedButton generationId={generationId} promptOnStart />}
  </div>;
}

export function BuildBuddyDialogue({ turns, generations, state, username, authLoading = false }: {
  turns: BuddyTurn[]; generations: GenerationActivity[]; state: PetState; username?: string | null; authLoading?: boolean;
}) {
  const { pet } = usePet();
  const [returning] = useState(() => {
    try { return localStorage.getItem(BUDDY_SEEN_KEY) === 'true'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(BUDDY_SEEN_KEY, 'true'); } catch { /* Chat also works without storage. */ }
  }, []);
  const log = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    const element = log.current;
    if (!element) return;
    const scroll = () => { if (follow.current) element.scrollTop = element.scrollHeight; };
    scroll();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scroll);
    if (element.firstElementChild) observer?.observe(element.firstElementChild);
    return () => observer?.disconnect();
  }, [turns.length, generations.length]);
  const restored = generations.filter(row => isAgentGeneration(row.endpoint) && isGenerationActive(row.status) && !turns.some(turn => turn.generationId === row.id))
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  return <div ref={log} className="pet-dialogue" role="log" aria-label="Build buddy conversation" aria-live="polite" aria-relevant="additions text"
    onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64; }}>
    <div className="pet-dialogue-content">
      <PetPromptGreeting state={state} showPetSwitch={false}>
        {returning ? `Welcome back${!authLoading && username?.trim() ? `, ${username.trim()}` : ''}! What would you like to build?`
          : `Hi, I’m ${pet.name} your build buddy! What would you like to build?`}
      </PetPromptGreeting>
      {restored.map(row => <div key={row.id} className="pet-dialogue-turn">
        <PetChatMessage user><p>{row.prompt || 'Image reference'}</p></PetChatMessage>
        <BuddyBuildMessages generationId={row.id} status={row.status} error={row.errorMessage} />
      </div>)}
      {turns.map(turn => {
        const generation = generations.find(row => row.id === turn.generationId);
        return <div key={turn.id} className="pet-dialogue-turn">
          <PetChatMessage user>
            {turn.imageUrl && <img className="pet-chat-reference" src={turn.imageUrl} alt={turn.imageName || 'Your reference image'} />}
            {turn.text && <p>{turn.text}</p>}
            {!turn.text && <p>{turn.imageName || 'Image reference'}</p>}
          </PetChatMessage>
          <PetChatMessage state={turn.reply ? 'idle' : 'listening'}>
            <p>{turn.reply || 'Let me take a look…'}</p>
          </PetChatMessage>
          {turn.error && <PetChatMessage><p role="status">I couldn’t start this build. {turn.error}</p></PetChatMessage>}
          {turn.generationId && (turn.method === 'llm' || turn.method === 'nova') && <BuddyBuildMessages
            generationId={turn.generationId} status={generation?.status || 'started'} error={generation?.errorMessage} />}
        </div>;
      })}
    </div>
  </div>;
}
