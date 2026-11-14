import React, { useEffect, useRef, useState } from 'react';
import { Camera, ChevronDown, Loader2, Shapes } from 'lucide-react';
import posthog from 'posthog-js';
import { recognizeParts, type RecognizedPart } from '../services/brickognizeApi';
import { IMAGE_UPLOAD_ACCEPT } from '../utils/prepareImageUpload';
import '../pages/InstructionsViewer.css';
import './PartsImageRecognition.css';

export function PartsImageRecognition({ disabled = false }: { disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const operation = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [parts, setParts] = useState<RecognizedPart[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => () => operation.current?.abort(), []);

  const upload = async (file?: File) => {
    if (!file || disabled || busy) return;
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true); setError(null); setParts(null); setExpanded(false);
    posthog.capture('existing_parts_image_uploaded', { size: file.size, type: file.type });
    try {
      const matches = await recognizeParts(file, controller.signal);
      if (controller.signal.aborted) return;
      setParts(matches);
      posthog.capture('existing_parts_image_recognized', { match_count: matches.length });
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : 'Could not recognize this image. Please try again.');
      posthog.capture('existing_parts_image_failed');
    } finally { if (!controller.signal.aborted) setBusy(false); }
  };

  return <section className="parts-image" aria-label="Identify parts from an image"
    onDragOver={event => { event.preventDefault(); event.stopPropagation(); }}
    onDrop={event => { event.preventDefault(); event.stopPropagation(); void upload(event.dataTransfer.files[0]); }}>
    <div className="parts-image-heading">
      <div><strong>Identify your bricks</strong><p>Photograph one part on a plain background.</p></div>
      <button type="button" className="parts-image-upload" disabled={disabled || busy} onClick={() => {
        posthog.capture('existing_parts_image_clicked'); input.current?.click();
      }}>
        {busy ? <Loader2 size={18} className="existing-parts-spinner" aria-hidden="true" /> : <Camera size={18} aria-hidden="true" />}
        {busy ? 'Identifying…' : 'Use image'}
      </button>
    </div>
    <input ref={input} type="file" hidden accept={IMAGE_UPLOAD_ACCEPT} aria-label="Upload a photo of LEGO parts" disabled={disabled || busy}
      onChange={event => { void upload(event.target.files?.[0]); event.target.value = ''; }} />
    <p className="parts-image-help">Photos are sent to Brickognize. Results are possible matches for one part; colors and quantities aren’t counted.</p>
    {busy && <p role="status" className="existing-parts-note">Looking for matching LEGO parts…</p>}
    {error && <p role="alert" className="existing-parts-error">{error}</p>}
    {parts?.length === 0 && <p role="status" className="existing-parts-note">No matching parts found. Try a closer, well-lit photo of a single brick.</p>}
    {!!parts?.length && <>
      <p role="status" className="parts-image-status">{parts.length} possible {parts.length === 1 ? 'match' : 'matches'} found</p>
      <details className="parts-image-results" open={expanded} onToggle={event => {
        const open = event.currentTarget.open;
        setExpanded(open);
        posthog.capture('existing_parts_image_results_toggled', { expanded: open, match_count: parts.length });
      }}>
        <summary>Detected part matches <span>{parts.length}</span><ChevronDown size={18} aria-hidden="true" /></summary>
        <ul className="instructions-parts-list parts-image-grid" aria-label="Detected part matches">
          {parts.map(part => <li className="instructions-part-row parts-image-part" key={part.id}>
            <span className="instructions-part-thumbnail parts-image-thumbnail">
              <Shapes size={28} aria-hidden="true" />
              {part.imageUrl && <img src={part.imageUrl} alt={part.name} loading="lazy" referrerPolicy="no-referrer"
                onError={event => { event.currentTarget.style.display = 'none'; }} />}
            </span>
            <strong>{part.name}</strong><span>Part {part.id}</span><small>{Math.round(part.score * 100)}% match</small>
          </li>)}
        </ul>
        <p className="parts-image-help">Check the closest match against your brick. These suggestions are not added to your build inventory.</p>
      </details>
    </>}
  </section>;
}
