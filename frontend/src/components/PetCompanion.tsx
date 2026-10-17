import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, Check, Pause, Play, X } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { usePet } from '../contexts/PetContext';
import { PETS, petVideoPath, type PetId, type PetState } from '../pets';
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
    {playing && <video key={source} src={source} poster={`/pets/${petId}.webp`} autoPlay muted loop playsInline disablePictureInPicture
      preload="none" className={readySource === source ? 'pet-video-ready' : ''}
      onPlaying={() => setReadySource(source)} onError={() => setFailedSource(source)} />}
  </span>;
}

/** Connects the prompt to its pet, and hands off to the floating companion when scrolled away. */
export function PetPromptGreeting({ mode = 'build', state }: { mode?: 'build' | 'edit' | 'upload'; state?: PetState }) {
  const { pet, activity, openPicker, pickerOpen, setInlineVisible } = usePet();
  const ref = useRef<HTMLDivElement>(null);
  const current = state || activity;
  useEffect(() => {
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      setInlineVisible(entries.some(entry => entry.isIntersecting));
    });
    if (ref.current) observer?.observe(ref.current);
    if (!observer) setInlineVisible(true);
    return () => { observer?.disconnect(); setInlineVisible(false); };
  }, [setInlineVisible]);
  return <div ref={ref} className={`pet-greeting pet-greeting--${mode}`}>
    <PetAvatar state={current} />
    <div className="pet-speech">
      <div className="pet-speech-heading"><span><i />{pet.name} · your build buddy</span>
        <button type="button" onClick={() => openPicker(`${mode}_prompt`)} title="Switch pet" aria-label={`Change pet, currently ${pet.name}`} aria-haspopup="dialog" aria-expanded={pickerOpen}>
          <ArrowLeftRight size={16} aria-hidden="true" /><span>Switch pet</span>
        </button>
      </div>
      <p>{current === 'building' ? (mode === 'edit' ? 'On it! I’m working on your changes.' : 'On it! I’m bringing your idea to life.')
        : current === 'celebrating' ? 'Look what we made! What shall we build next?'
        : mode === 'edit' ? 'What should we change? I’m all ears.'
        : mode === 'upload' ? 'Show me your build. Let’s make it yours.' : 'Hi, I’m ' + pet.name + '! What shall we build?'}</p>
    </div>
  </div>;
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
        <h2 id="pet-picker-title">Choose your build buddy</h2>
        <p id="pet-picker-description">Your buddy follows you across BrickBuilder. Switch any time.</p>
      </div>
      <button type="button" className="pet-close" onClick={closePicker} aria-label="Close pet picker"><X size={20} /></button>
    </div>
    <div className="pet-choices" role="group" aria-label="Choose your pet">
      {PETS.map(option => <button key={option.id} type="button" aria-label={`Choose ${option.name}`} aria-pressed={option.id === pet.id}
        className={`pet-choice pet-choice--${option.id}`} onClick={() => selectPet(option.id)}>
        <span className="pet-choice-check">{option.id === pet.id && <Check size={15} aria-hidden="true" />}</span>
        <PetAvatar id={option.id} still />
        <strong>{option.name}</strong><span className="pet-choice-title">{option.title}</span><span className="pet-choice-description">{option.description}</span>
      </button>)}
    </div>
    <div className="pet-picker-footer"><span>Pet animations</span>
      <button type="button" aria-pressed={!motion} onClick={() => setMotion(!motion)}>
        {motion ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
        {motion ? 'Pause animations' : 'Play animations'}
      </button>
    </div>
  </dialog>;
}

export function PetCompanion() {
  const { pet, activity, inlineVisible, openPicker, pickerOpen } = usePet();
  const { pathname } = useLocation();
  const purchasePage = pathname === '/generated-model' || pathname === '/order';
  return <>
    {!inlineVisible && <button type="button" className={`pet-dock ${purchasePage ? 'pet-dock--purchase' : ''}`}
      onClick={() => openPicker('companion_dock')} aria-label={`${pet.name}, your build buddy. Change pet`} aria-haspopup="dialog" aria-expanded={pickerOpen}>
      <PetAvatar state={activity} />
      <span className="pet-dock-label"><strong>{pet.name}</strong><span>{activity === 'building' ? 'Building with you' : 'Your build buddy'}</span></span>
      <ArrowLeftRight size={13} aria-hidden="true" />
    </button>}
    <PetPicker />
  </>;
}
