import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { ArrowLeft, Pause, Play } from 'lucide-react';
import posthog from 'posthog-js';
import { PetAvatar } from '../components/PetCompanion';
import { usePet } from '../contexts/PetContext';
import './pet-preview.css';

const BACKGROUNDS = ['Checkerboard', 'Cream', 'Midnight'] as const;

export default function PetPreviewPage() {
  const [background, setBackground] = useState<typeof BACKGROUNDS[number]>('Checkerboard');
  const { motion, setMotion } = usePet();
  return <main className="pet-preview-page">
    <Helmet><title>Pip transparency preview — BrickBuilder</title><meta name="robots" content="noindex" /></Helmet>
    <Link to="/" className="pet-preview-back" onClick={() => posthog.capture('pet_preview_back_clicked')}><ArrowLeft size={16} />Back to building</Link>
    <header><span className="pet-eyebrow">ONE LITTLE EXPERIMENT</span><h1>Pip, without the backdrop.</h1>
      <p>The same idle animation, with the background removed.<br />Try a darker surface to see the difference.</p>
    </header>
    <div className="pet-preview-controls">
      <div role="group" aria-label="Preview background">{BACKGROUNDS.map(option => <button type="button" key={option} aria-pressed={background === option}
        onClick={() => { setBackground(option); posthog.capture('pet_preview_background_selected', { background: option.toLowerCase() }); }}>{option}</button>)}</div>
      <button type="button" className="pet-preview-motion" aria-pressed={!motion} onClick={() => setMotion(!motion)}>
        {motion ? <Pause size={15} /> : <Play size={15} />}{motion ? 'Pause' : 'Play'}
      </button>
    </div>
    <div className={`pet-preview-grid pet-preview-grid--${background.toLowerCase()}`}>
      <figure><div className="pet-preview-stage pet-preview-stage--original"><PetAvatar id="pip" videoSource="/pets/pip-idle.mp4" /></div>
        <figcaption><strong>Original</strong><span>White studio background</span></figcaption></figure>
      <figure><div className="pet-preview-stage"><PetAvatar id="pip" /></div>
        <figcaption><strong>Transparent</strong><span>Just Pip. Breathing, blinking, waving.</span></figcaption></figure>
    </div>
    <p className="pet-preview-note">This preview changes only Pip’s idle loop. Nib, Clik, and the other animations stay as they are.</p>
  </main>;
}
