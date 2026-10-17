import React, { useState } from 'react';
import { Gift, ImagePlus, Sparkles } from 'lucide-react';
import posthog from 'posthog-js';
import { PROMPT_EXAMPLES, pickPromptExampleIndex } from '../utils/promptExamples';
import './BuildBuddySuggestions.css';

export function BuildBuddySuggestions({ disabled, onRandom, onGift, onUpload }: {
  disabled: boolean;
  onRandom: (prompt: string) => void;
  onGift: () => void;
  onUpload: () => void;
}) {
  const [exampleIndex, setExampleIndex] = useState(() => pickPromptExampleIndex());
  const example = PROMPT_EXAMPLES[exampleIndex];
  const track = (suggestion: string) => posthog.capture('build_buddy_suggestion_clicked', { suggestion });
  return <div className="build-buddy-suggestions" role="group" aria-label="Build suggestions">
    <button type="button" disabled={disabled} onClick={() => {
      track('random');
      onRandom(`create ${example} out of LEGO`);
      setExampleIndex(pickPromptExampleIndex(exampleIndex));
    }}><Sparkles size={16} aria-hidden="true" /><span>Try {example}</span></button>
    <button type="button" disabled={disabled} onClick={() => { track('gift'); onGift(); }}>
      <Gift size={16} aria-hidden="true" /><span>Gift idea?</span>
    </button>
    <button type="button" disabled={disabled} onClick={() => { track('upload'); onUpload(); }}>
      <ImagePlus size={16} aria-hidden="true" /><span>Upload image</span>
    </button>
  </div>;
}
