import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, FileUp, Loader2, Search } from 'lucide-react';
import posthog from 'posthog-js';
import { PartsInventoryApi, inventoryQuantity, type InventoryResult, type LegoSet, type PartsInventory } from '../services/partsInventoryApi';
import './ExistingPartsDesigner.css';
import { PreviousOrderParts } from './PreviousOrderParts';

export function ExistingPartsDesigner({ onSelect, onLogin }: { onSelect: (inventory: PartsInventory) => void; onLogin?: () => void }) {
  const [query, setQuery] = useState('');
  const [sets, setSets] = useState<LegoSet[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [review, setReview] = useState<InventoryResult | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);

  useEffect(() => {
    setSets(null); setSearchError(null); setSearching(false);
    if (query.trim().length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      posthog.capture('existing_parts_set_search', { query_length: query.trim().length });
      void PartsInventoryApi.search(query, controller.signal).then(rows => {
        if (!controller.signal.aborted) setSets(rows);
      }).catch(err => {
        if (!controller.signal.aborted) setSearchError(err instanceof Error ? err.message : 'Set search is unavailable.');
      }).finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query]);

  const choose = (inventory: PartsInventory) => {
    posthog.capture('existing_parts_inventory_selected', { source: inventory.source,
      piece_count: inventoryQuantity(inventory), part_color_count: inventory.parts.length });
    onSelect(inventory);
  };
  const load = async (get: (signal: AbortSignal) => Promise<InventoryResult>) => {
    operation.current?.abort();
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(null); setReview(null);
    try {
      const result = await get(controller.signal);
      if (controller.signal.aborted) return;
      if (result.unavailable.length) setReview(result);
      else choose(result.inventory);
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Could not read these parts.');
        posthog.capture('existing_parts_inventory_failed');
      }
    } finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const upload = (file?: File) => {
    if (!file || busy) return;
    posthog.capture('existing_parts_file_uploaded', { format: file.name.split('.').pop()?.toLowerCase(), size: file.size });
    void load(signal => PartsInventoryApi.upload(file, signal));
  };

  return <main className="existing-parts-screen" aria-labelledby="existing-parts-title">
    <div className="existing-parts-intro">
      <h1 id="existing-parts-title" className="landing-hero-title">Design <span>LEGO</span> from your existing sets</h1>
      <p>Give your bricks a new story. BrickBuilder designs with only your parts, colors, and quantities.</p>
    </div>
    <div className="existing-parts-card" onDragOver={event => { event.preventDefault(); event.stopPropagation(); }}
      onDragEnter={event => event.stopPropagation()} onDrop={event => { event.preventDefault(); event.stopPropagation(); upload(event.dataTransfer.files[0]); }}>
      <PreviousOrderParts onSelect={choose} onLogin={onLogin} disabled={busy} />
      <div className="existing-parts-divider"><span />or<span /></div>
      <label className="existing-parts-search"><Search size={19} aria-hidden="true" />
        <input aria-label="Search LEGO sets" value={query} maxLength={100} placeholder="Search by set name or number" disabled={busy}
          onChange={event => { setQuery(event.target.value); setReview(null); }} />
      </label>
      {searching && <p role="status" className="existing-parts-note">Searching sets…</p>}
      {searchError && <p role="alert" className="existing-parts-error">{searchError}</p>}
      {sets && sets.length > 0 && <ul className="existing-parts-results" aria-label="LEGO set search results">
        {sets.map(set => <li key={set.set_num}><button type="button" disabled={busy} onClick={() => {
          posthog.capture('existing_parts_set_clicked', { set_number: set.set_num });
          void load(signal => PartsInventoryApi.select(set.set_num, signal));
        }}><span><strong>{set.name}</strong><small>{set.set_num} · {set.year} · {set.num_parts.toLocaleString()} pieces</small></span><ArrowRight size={18} aria-hidden="true" /></button></li>)}
      </ul>}
      {sets?.length === 0 && <p role="status" className="existing-parts-note">No matching set found. Download a parts list from Rebrickable or BrickLink and upload it below.</p>}
      {error && <p role="alert" className="existing-parts-error">{error}</p>}
      {review && <div className="existing-parts-review" role="status">
        <strong>{review.inventory.name}</strong>
        <p>Nova can use {inventoryQuantity(review.inventory).toLocaleString()} pieces. {review.unavailable.reduce((n, p) => n + p.quantity, 0).toLocaleString()} pieces have no exact part or color match and will be left out. No substitutes will be added.</p>
        <details onToggle={event => { if (event.currentTarget.open) posthog.capture('existing_parts_unavailable_expanded'); }}><summary>See unavailable pieces</summary>
          <ul>{review.unavailable.map((p, i) => <li key={i}>{p.quantity} × {p.part_id}, Rebrickable color {p.color_id}</li>)}</ul>
        </details>
        <button type="button" className="existing-parts-use" onClick={() => choose(review.inventory)}>Use {inventoryQuantity(review.inventory).toLocaleString()} available pieces <ArrowRight size={16} aria-hidden="true" /></button>
      </div>}
      <div className="existing-parts-divider"><span />or<span /></div>
      <input ref={input} type="file" accept=".ldr,.io,.csv,.xml,.mpd" aria-label="Upload parts list" hidden disabled={busy}
        onChange={event => { upload(event.target.files?.[0]); event.target.value = ''; }} />
      <button type="button" className="existing-parts-upload" disabled={busy} onClick={() => {
        posthog.capture('existing_parts_upload_clicked'); input.current?.click();
      }}>
        {busy ? <Loader2 className="existing-parts-spinner" size={30} aria-hidden="true" /> : <FileUp size={32} strokeWidth={1.5} aria-hidden="true" />}
        <strong>{busy ? 'Reading your parts…' : 'Upload a parts list'}</strong>
        <span>Drop a file here or choose one</span>
        <span className="existing-parts-filetypes">LDR · IO · CSV · XML · MPD <span>up to 16 MB</span></span>
      </button>
      <p className="existing-parts-format-help">Studio and LDraw models, CSV parts lists, or BrickLink XML. For your own CSV, use <code>part_id,color_id,quantity</code> with LDraw IDs.</p>
    </div>
  </main>;
}
