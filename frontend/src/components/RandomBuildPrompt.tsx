import React from 'react';
import { PetChatMessage } from './PetCompanion';

export function RandomBuildPrompt({ suggestion, onYes, onElse, onBack }: {
  suggestion: { status: 'loading' | 'ready' | 'error'; idea: string | null };
  onYes: () => void;
  onElse: () => void;
  onBack: () => void;
}) {
  return <PetChatMessage>
    <p role={suggestion.status === 'ready' ? undefined : 'status'}>
      {suggestion.status === 'loading' ? 'I’m thinking of something fun to build…'
        : suggestion.status === 'error' ? 'I couldn’t think of an idea right now. Want me to try again?'
          : `How about ${suggestion.idea}?`}
    </p>
    <div className="pet-chat-actions">
      {suggestion.status === 'ready' && <button type="button" className="pet-chat-action" onClick={onYes}>Yes</button>}
      {suggestion.status !== 'loading' && <button type="button" className="pet-chat-action" onClick={onElse}>
        {suggestion.status === 'error' ? 'Try again' : 'Something else'}
      </button>}
      <button type="button" className="pet-chat-action" onClick={onBack}>Go back</button>
    </div>
  </PetChatMessage>;
}
