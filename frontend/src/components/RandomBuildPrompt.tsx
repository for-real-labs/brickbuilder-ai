import React from 'react';
import { PetChatMessage, PetTypingIndicator } from './PetCompanion';

export function RandomBuildPrompt({ suggestion, onYes, onElse, onBack }: {
  suggestion: { status: 'loading' | 'ready' | 'error'; idea: string | null };
  onYes: () => void;
  onElse: () => void;
  onBack: () => void;
}) {
  if (suggestion.status === 'loading') return <div className="pet-random-build-loading">
    <PetChatMessage state="listening"><PetTypingIndicator /></PetChatMessage>
    <div className="pet-chat-actions pet-random-build-loading-actions">
      <button type="button" className="pet-chat-action" onClick={onBack}>Go back</button>
    </div>
  </div>;

  return <PetChatMessage>
    <p role={suggestion.status === 'error' ? 'status' : undefined}>
      {suggestion.status === 'error' ? 'I couldn’t think of an idea right now. Want me to try again?'
        : `How about ${suggestion.idea}?`}
    </p>
    <div className="pet-chat-actions">
      {suggestion.status === 'ready' && <button type="button" className="pet-chat-action" onClick={onYes}>Yes</button>}
      <button type="button" className="pet-chat-action" onClick={onElse}>
        {suggestion.status === 'error' ? 'Try again' : 'No'}
      </button>
      <button type="button" className="pet-chat-action" onClick={onBack}>Go back</button>
    </div>
  </PetChatMessage>;
}
