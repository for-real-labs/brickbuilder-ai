import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { ArrowLeft, Pause, Play } from 'lucide-react';
import posthog from 'posthog-js';
import { PetAvatar } from '../components/PetCompanion';
import { PETS, type PetId } from '../pets';
import { usePet } from '../contexts/PetContext';
import './pet-preview.css';

const ANIMATIONS = ['idle', 'building', 'celebrating'] as const;
const BACKGROUNDS = ['Checkerboard', 'Cream', 'Midnight'] as const;

export default function PetPreviewPage() {
  const [background, setBackground] = useState<typeof BACKGROUNDS[number]>('Checkerboard');
  const [previewPet, setPreviewPet] = useState<PetId>('pip');
  const [animation, setAnimation] = useState<typeof ANIMATIONS[number]>('idle');
  const { motion, setMotion } = usePet();
  return <main className="pet-preview-page">
    <Helmet><title>Pet animation preview — BrickBuilder</title><meta name="robots" content="noindex" /></Helmet>
    <Link to="/" className="pet-preview-back" onClick={() => posthog.capture('pet_preview_back_clicked')}><ArrowLeft size={16} />Back to building</Link>
    <header><span className="pet-eyebrow">BUILD BUDDIES</span><h1>Little buddies. Smooth loops.</h1>
      <p>Original clips on the left. Seamless loops on the right.<br />Try a darker surface to check the transparent edges.</p>
    </header>
    <div className="pet-preview-filters">
      <label>Pet<select value={previewPet} onChange={event => {
        const next = PETS.find(pet => pet.id === event.target.value);
        if (!next) return;
        setPreviewPet(next.id); posthog.capture('pet_preview_pet_selected', { pet_id: next.id });
      }}>{PETS.map(pet => <option key={pet.id} value={pet.id}>{pet.name}</option>)}</select></label>
      <label>Animation<select value={animation} onChange={event => {
        const next = ANIMATIONS.find(state => state === event.target.value);
        if (!next) return;
        setAnimation(next); posthog.capture('pet_preview_animation_selected', { pet_id: previewPet, state: next });
      }}>{ANIMATIONS.map(state => <option key={state} value={state}>{state[0].toUpperCase() + state.slice(1)}</option>)}</select></label>
    </div>
    <div className="pet-preview-controls">
      <div role="group" aria-label="Preview background">{BACKGROUNDS.map(option => <button type="button" key={option} aria-pressed={background === option}
        onClick={() => { setBackground(option); posthog.capture('pet_preview_background_selected', { background: option.toLowerCase() }); }}>{option}</button>)}</div>
      <button type="button" className="pet-preview-motion" aria-pressed={!motion} onClick={() => setMotion(!motion)}>
        {motion ? <Pause size={15} /> : <Play size={15} />}{motion ? 'Pause' : 'Play'}
      </button>
    </div>
    <div className={`pet-preview-grid pet-preview-grid--${background.toLowerCase()}`}>
      <figure><div className="pet-preview-stage pet-preview-stage--original"><PetAvatar id={previewPet} state={animation} videoSource={`/pets/${previewPet}-${animation}.mp4`} /></div>
        <figcaption><strong>Original</strong><span>White studio background</span></figcaption></figure>
      <figure><div className="pet-preview-stage"><PetAvatar id={previewPet} state={animation} /></div>
        <figcaption><strong>Seamless + transparent</strong><span>Matching start and end poses.</span></figcaption></figure>
    </div>
    <p className="pet-preview-note">Pip, Nib, and Clik use seamless, transparent animations throughout the app, including idle, building, and celebrating.</p>
  </main>;
}
