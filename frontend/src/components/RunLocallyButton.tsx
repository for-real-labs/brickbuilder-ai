import React, { useId, useRef, useState } from 'react';
import { Check, Copy, Monitor, X } from 'lucide-react';
import posthog from 'posthog-js';
import prompt from '../content/run-locally.md?raw';
import './run-locally.css';

export const LOCAL_SETUP_PROMPT = prompt.trim();

export function RunLocallyButton() {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const track = (event: string) => posthog.capture(event, { source: 'header' });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(LOCAL_SETUP_PROMPT);
      setStatus('copied');
      track('run_locally_prompt_copied');
    } catch {
      setStatus('failed');
      track('run_locally_copy_failed');
    }
  };
  return <>
    <button ref={trigger} type="button" className="run-locally-trigger" onClick={() => {
      setStatus('idle');
      dialog.current?.showModal();
      track('run_locally_opened');
    }}><Monitor size={15} aria-hidden="true" />Run on your computer</button>
    <dialog ref={dialog} className="run-locally-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-intro`}
      onClose={() => { trigger.current?.focus(); track('run_locally_closed'); }}>
      <div className="run-locally-heading">
        <div><p className="run-locally-eyebrow">OPEN SOURCE · YOUR WORKSPACE</p><h2 id={`${id}-title`}>Run on your computer</h2></div>
        <button type="button" aria-label="Close local setup" className="run-locally-close" onClick={() => dialog.current?.close()}><X size={20} aria-hidden="true" /></button>
      </div>
      <p id={`${id}-intro`}>Copy and paste this into Claude Code or an equivalent coding assistant. Ask it to install and run BrickBuilder for you.</p>
      <textarea aria-label="Local installation prompt" readOnly value={LOCAL_SETUP_PROMPT} spellCheck={false} />
      <p className="run-locally-note">Free, MIT-licensed software. Uses your own AI account or API key; provider costs and limits may apply. All parts requires Docker.</p>
      <div className="run-locally-actions">
        <a href="https://github.com/for-real-labs/brickbuilder-ai" target="_blank" rel="noopener noreferrer" onClick={() => track('run_locally_github_clicked')}>View on GitHub ↗</a>
        <button type="button" className="run-locally-copy" onClick={() => void copy()}>{status === 'copied' ? <Check size={17} aria-hidden="true" /> : <Copy size={17} aria-hidden="true" />}{status === 'copied' ? 'Copied!' : 'Copy prompt'}</button>
      </div>
      <p role="status" className="run-locally-status">{status === 'failed' ? 'Clipboard unavailable. Select the prompt above and copy it manually.' : status === 'copied' ? 'Ready to paste into your coding assistant.' : ''}</p>
    </dialog>
  </>;
}
