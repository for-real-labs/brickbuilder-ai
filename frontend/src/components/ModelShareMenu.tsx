import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Facebook, Instagram, Link, Share2 } from 'lucide-react';
import posthog from 'posthog-js';
import { getGeneratedModelPath } from '../utils/generationRoutes';

interface Props { generationId: string; modelName: string }

export function ModelShareMenu({ generationId, modelName }: Props) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState(false);
  const menuId = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const url = new URL(getGeneratedModelPath(generationId, true), window.location.origin).href;
  const text = `Check out ${modelName} on BrickBuilder!`;
  const rowClass = 'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-500';
  const track = (destination: string) => posthog.capture('generated_model_share_clicked', { generation_id: generationId, destination });

  useEffect(() => { setOpen(false); setMessage(''); setCopied(false); }, [generationId]);
  useEffect(() => {
    if (!open) return;
    container.current?.querySelector<HTMLButtonElement>('[data-share-action]')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);

  const copy = async (destination: 'url' | 'instagram') => {
    track(destination);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setMessage(destination === 'instagram' ? 'Link copied. Paste it into an Instagram message or story link sticker.' : 'Link copied!');
    } catch {
      setCopied(false);
      input.current?.focus(); input.current?.select();
      setMessage('Select and copy the link below, then paste it where you want to share.');
    }
  };

  return <div ref={container} className="relative shrink-0" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
  }} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }}>
    <button ref={trigger} type="button" aria-expanded={open} aria-controls={menuId} aria-haspopup="dialog"
      className="inline-flex min-h-11 items-center gap-2 rounded-full border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-500"
      onClick={() => {
        if (!open) { setMessage(''); setCopied(false); posthog.capture('generated_model_share_opened', { generation_id: generationId }); }
        setOpen(!open);
      }}>
      <Share2 size={16} aria-hidden="true" /> Share <ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && <div id={menuId} role="dialog" aria-label="Share model" className="absolute right-0 top-full z-40 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-2xl border border-slate-200 bg-white p-2 shadow-xl">
      <button type="button" data-share-action className={rowClass} onClick={() => void copy('url')}>
        {copied ? <Check size={18} aria-hidden="true" /> : <Link size={18} aria-hidden="true" />} {copied ? 'Link copied' : 'Copy link'}
      </button>
      <a className={rowClass} href={`https://www.facebook.com/sharer/sharer.php?${new URLSearchParams({ u: url })}`} target="_blank" rel="noopener noreferrer" onClick={() => { track('facebook'); setOpen(false); }}>
        <Facebook size={18} aria-hidden="true" /> Facebook
      </a>
      <button type="button" className={rowClass} onClick={() => void copy('instagram')}><Instagram size={18} aria-hidden="true" /> Instagram <span className="ml-auto text-xs text-slate-400">Copy link</span></button>
      <a className={rowClass} href={`https://twitter.com/intent/tweet?${new URLSearchParams({ url, text })}`} target="_blank" rel="noopener noreferrer" onClick={() => { track('twitter'); setOpen(false); }}>
        <span aria-hidden="true" className="w-[18px] text-center font-bold">𝕏</span> X (Twitter)
      </a>
      <div className="mt-1 border-t border-slate-100 px-2 pt-3 pb-1">
        <label htmlFor={`${menuId}-url`} className="mb-1 block text-xs font-medium text-slate-500">Model link</label>
        <input ref={input} id={`${menuId}-url`} readOnly value={url} onFocus={event => event.currentTarget.select()} onClick={() => track('select_link')} className="w-full min-w-0 rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-xs text-slate-600" />
        {message && <p role="status" className="mt-2 text-xs leading-relaxed text-slate-600">{message}</p>}
      </div>
    </div>}
  </div>;
}
