import React from 'react';
import { ImagePlus, Sparkles, X } from 'lucide-react';

/** Upload-first entry point; the parent form owns submission and generation state. */
export function LandingCreateInput({ prompt, onChange, onFocus, onBlur, inputRef, previewUrl, fileName,
  onPick, onRemove, onRandom, busy, submitDisabled, random, validationId }: {
  prompt: string; onChange: (value: string) => void; onFocus: () => void; onBlur: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>; previewUrl: string | null; fileName?: string;
  onPick: () => void; onRemove: () => void; onRandom: () => void;
  busy: boolean; submitDisabled: boolean; random: boolean; validationId?: string;
}) {
  return <div className="landing-create-input">
    {!random && <>
      <div className="landing-upload-prompt">
        <button type="button" className="landing-upload-target" aria-label="Upload image" onClick={onPick} disabled={busy}>
          {previewUrl ? <img src={previewUrl} alt="Uploaded preview" /> : <ImagePlus size={30} strokeWidth={1.5} aria-hidden="true" />}
          <span>{previewUrl ? fileName || 'Change image' : 'Upload an image'}</span>
        </button>
        {previewUrl && <button type="button" className="landing-upload-remove" aria-label="Remove image" onClick={onRemove} disabled={busy}><X size={16} aria-hidden="true" /></button>}
        <div className="landing-input-divider" aria-hidden="true"><span />or<span /></div>
        <input id="landing-build-prompt" ref={inputRef} aria-label="Describe your model" aria-describedby={validationId}
          value={prompt} maxLength={2000} placeholder={previewUrl ? 'Add optional image instructions' : 'Describe your idea'}
          onChange={event => onChange(event.target.value)} onFocus={onFocus} onBlur={onBlur} disabled={busy}
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
