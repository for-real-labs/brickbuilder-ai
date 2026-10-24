import React, { useLayoutEffect, useRef, useState } from 'react';
import posthog from 'posthog-js';
import { ImagePlus, Sparkles, X } from 'lucide-react';

/** Upload-first entry point; the parent form owns submission and generation state. */
export function LandingCreateInput({ prompt, onChange, onFocus, onBlur, inputRef, previewUrl, fileName,
  onPick, onRemove, onRandom, busy, submitDisabled, random, validationId }: {
  prompt: string; onChange: (value: string) => void; onFocus: () => void; onBlur: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>; previewUrl: string | null; fileName?: string;
  onPick: () => void; onRemove: () => void; onRandom: () => void;
  busy: boolean; submitDisabled: boolean; random: boolean; validationId?: string;
}) {
  const [textFirst, setTextFirst] = useState(Boolean(prompt));
  const cardRef = useRef<HTMLDivElement>(null);
  const previousLayout = useRef<{ height: number; children: Map<Element, DOMRect> } | null>(null);

  useLayoutEffect(() => {
    const card = cardRef.current;
    const previous = previousLayout.current;
    previousLayout.current = null;
    if (!card || !previous || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const timing = { duration: 360, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' };
    const animations: Animation[] = [];
    if (card.animate) animations.push(card.animate([{ height: `${previous.height}px` }, { height: `${card.getBoundingClientRect().height}px` }], timing));
    for (const [child, before] of previous.children) {
      if (!card.contains(child) || !child.animate) continue;
      const after = child.getBoundingClientRect();
      animations.push(child.animate([
        { transform: `translate(${before.x - after.x}px, ${before.y - after.y}px)` },
        { transform: 'translate(0, 0)' },
      ], timing));
    }
    return () => animations.forEach(animation => animation.cancel());
  }, [textFirst]);

  const focusPrompt = () => {
    if (!textFirst) {
      const card = cardRef.current;
      if (card) previousLayout.current = { height: card.getBoundingClientRect().height,
        children: new Map(Array.from(card.children).map(child => [child, child.getBoundingClientRect()])) };
      setTextFirst(true);
      posthog.capture('landing_text_entry_expanded');
    }
    onFocus();
  };

  return <div className="landing-create-input">
    {!random && <>
      <div ref={cardRef} className={`landing-upload-prompt${textFirst ? ' landing-upload-prompt--text-first' : ''}`}>
        <button type="button" className="landing-upload-target" aria-label="Upload image" onClick={onPick} disabled={busy}>
          {previewUrl ? <img src={previewUrl} alt="Uploaded preview" /> : <ImagePlus size={30} strokeWidth={1.5} aria-hidden="true" />}
          <span>{previewUrl ? fileName || 'Change image' : textFirst ? 'Upload image' : 'Upload an image'}</span>
        </button>
        {previewUrl && <button type="button" className="landing-upload-remove" aria-label="Remove image" onClick={onRemove} disabled={busy}><X size={16} aria-hidden="true" /></button>}
        <div className="landing-input-divider" aria-hidden="true"><span />or<span /></div>
        <input id="landing-build-prompt" ref={inputRef} aria-label="Describe your model" aria-describedby={validationId}
          value={prompt} maxLength={2000} placeholder={previewUrl ? 'Add optional image instructions' : 'Describe your idea'}
          onChange={event => onChange(event.target.value)} onFocus={focusPrompt} onBlur={onBlur} disabled={busy}
          onKeyDown={event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            if (event.repeat || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            event.currentTarget.form?.requestSubmit();
          }} />
      </div>
      <button type="button" className="landing-random-idea" onClick={onRandom} disabled={busy}>
        <Sparkles size={15} aria-hidden="true" />Try something random
      </button>
    </>}
    <button type="submit" aria-label="Generate" className="landing-generate-button" disabled={submitDisabled}>
      {busy ? 'Preparing…' : 'Generate'}
    </button>
  </div>;
}
