import React, { useEffect, useRef, useState } from 'react';
import { PawPrint, Check, Pause, Play, X } from 'lucide-react';
import { usePet } from '../contexts/PetContext';
import { PETS, petVideoPath, petVideoSources, type PetId, type PetState } from '../pets';
import { PetResponseText, animatePetParagraphs } from './PetResponseText';
import './PetCompanion.css';

export function PetAvatar({ id, state = 'idle', still = false, videoSource }: { id?: PetId; state?: PetState; still?: boolean; videoSource?: string }) {
  const { pet, motion } = usePet();
  const petId = id || pet.id;
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [reduced, setReduced] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [readySource, setReadySource] = useState<string | null>(null);
  const source = videoSource || petVideoPath(petId, state);
  const transparent = source.endsWith('-alpha.webm');
  const sources = videoSource ? [{ src: videoSource, type: undefined }] : petVideoSources(petId, state);

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media?.matches ?? false);
    update();
    media?.addEventListener?.('change', update);
    const visibility = () => setHidden(document.hidden);
    visibility();
    document.addEventListener('visibilitychange', visibility);
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      setVisible(entries.some(entry => entry.isIntersecting));
    }, { rootMargin: '40px' });
    if (ref.current) observer?.observe(ref.current);
    if (!observer) setVisible(true);
    return () => {
      observer?.disconnect();
      media?.removeEventListener?.('change', update);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);

  const playing = motion && !reduced && !hidden && visible && !still && failedSource !== source;
  return <span ref={ref} className={`pet-avatar pet-avatar--${state}${transparent ? ' pet-avatar--transparent' : ''}${transparent && playing && readySource === source ? ' pet-avatar--alpha-playing' : ''}`} aria-hidden="true" data-pet={petId}>
    <img src={`/pets/${petId}.webp`} alt="" width="512" height="512" draggable={false} />
    {playing && <video key={source} poster={`/pets/${petId}.webp`} autoPlay muted loop playsInline disablePictureInPicture
      preload="none" className={readySource === source ? 'pet-video-ready' : ''}
      onPlaying={() => setReadySource(source)} onError={event => {
        if (event.target === event.currentTarget) setFailedSource(source);
      }}>
      {sources.map((option, index) => <source key={option.src} src={option.src} type={option.type}
        onError={index === sources.length - 1 ? () => setFailedSource(source) : undefined} />)}
    </video>}
  </span>;
}

export function PetSwitchButton({ source, className, onOpen, returnFocusRef }: {
  source: string;
  className?: string;
  onOpen?: () => void;
  returnFocusRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const { pet, openPicker, pickerOpen } = usePet();
  return <button type="button" className={className} onClick={() => {
    openPicker(source, returnFocusRef?.current);
    onOpen?.();
  }} title="Build Buddy" aria-label={`Change Build Buddy, currently ${pet.name}`} aria-haspopup="dialog" aria-expanded={pickerOpen}>
    <PawPrint size={16} className="shrink-0" aria-hidden="true" /><span>Build Buddy</span>
  </button>;
}

/** Connects the prompt to its pet and the shared buddy picker. */
export function PetPromptGreeting({ mode = 'build', state, showPetSwitch = true, children, actions }: { mode?: 'build' | 'edit' | 'upload'; state?: PetState; showPetSwitch?: boolean; children?: React.ReactNode; actions?: React.ReactNode }) {
  const { pet, activity } = usePet();
  const current = state || activity;
  return <div className={`pet-greeting pet-greeting--${mode}`}>
    <PetAvatar state={current} />
    <div className="pet-speech">
      {showPetSwitch && <div className="pet-speech-heading"><PetSwitchButton source={`${mode}_prompt`} /></div>}
      <p><PetResponseText>{children ?? (current === 'building' ? (mode === 'edit' ? 'I’m making your changes.' : 'I’m making your build.')
        : current === 'celebrating' ? 'Look what we made! What should we build next?'
        : mode === 'edit' ? 'What do you want to change?'
        : mode === 'upload' ? 'Show me your build. What should we change?' : 'Hi! I’m ' + pet.name + '. Tell me what to build!')}</PetResponseText></p>
      {actions}
    </div>
  </div>;
}

export function PetChatMessage({ children, user = false, state = 'idle' }: {
  children: React.ReactNode; user?: boolean; state?: PetState;
}) {
  return <div className={`pet-chat-message${user ? ' pet-chat-message--user' : ''}`}>
    {!user && <PetAvatar state={state} />}
    <div className="pet-chat-bubble"><span className="sr-only">{user ? 'You: ' : 'Build buddy: '}</span>{user ? children : animatePetParagraphs(children)}</div>
  </div>;
}

export function PetTypingIndicator() {
  return <span className="pet-typing-indicator" role="status" aria-label="Build buddy is typing">
    <span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" />
  </span>;
}

function PetPicker() {
  const { pet, motion, pickerOpen, selectPet, setMotion, closePicker } = usePet();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    dialog.current?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = overflow; };
  }, [pickerOpen]);
  if (!pickerOpen) return null;
  return <dialog ref={dialog} className="pet-picker" aria-labelledby="pet-picker-title" aria-describedby="pet-picker-description"
    onCancel={event => { event.preventDefault(); closePicker(); }} onClose={closePicker}>
    <div className="pet-picker-header">
      <div>
        <h2 id="pet-picker-title">Choose your build buddy / pet</h2>
        <p id="pet-picker-description">Your buddy follows you across BrickBuilder. Switch any time.</p>
      </div>
      <button type="button" className="pet-close" onClick={closePicker} aria-label="Close pet picker"><X size={20} /></button>
    </div>
    <div className="pet-choices" role="group" aria-label="Choose your build buddy / pet">
      {PETS.map(option => <button key={option.id} type="button" aria-label={`Choose ${option.name}`} aria-pressed={option.id === pet.id}
        className={`pet-choice pet-choice--${option.id}`} onClick={() => selectPet(option.id)}>
        <span className="pet-choice-check">{option.id === pet.id && <Check size={15} aria-hidden="true" />}</span>
        <PetAvatar id={option.id} still />
        <strong>{option.name}</strong><span className="pet-choice-title">{option.title}</span><span className="pet-choice-description">{option.description}</span>
      </button>)}
    </div>
    <div className="pet-picker-footer"><span>Build buddy / pet animations</span>
      <button type="button" aria-pressed={!motion} onClick={() => setMotion(!motion)}>
        {motion ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
        {motion ? 'Pause animations' : 'Play animations'}
      </button>
    </div>
  </dialog>;
}

export function PetCompanion() {
  return <PetPicker />;
}
