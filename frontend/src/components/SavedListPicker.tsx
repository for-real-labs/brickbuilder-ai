import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Layers } from 'lucide-react';
import posthog from 'posthog-js';
import { useAuth } from '../contexts/AuthContext';
import { SavedLists, listsPerPage, type PartsListSummary, type SavedPartsList } from '../services/savedPartsLists';
import type { PartsInventory } from '../services/partsInventoryApi';
import './SavedPartsLists.css';

export function SavedListPicker({ owner, onChoose, disabled }: {
  owner: string; onChoose: (list: SavedPartsList) => void; disabled?: boolean;
}) {
  const [rows, setRows] = useState<PartsListSummary[]>([]);
  const [page, setPage] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const selection = useRef<AbortController | null>(null);
  useEffect(() => () => selection.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    setRows([]); setLoading(true); setError('');
    SavedLists.page(owner, page * listsPerPage, controller.signal).then(result => {
      if (!controller.signal.aborted) setRows(result);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [owner, page, attempt]);
  async function open(id: string) {
    selection.current?.abort();
    const controller = new AbortController();
    selection.current = controller;
    setOpening(true); setError('');
    try {
      const list = await SavedLists.get(owner, id, controller.signal);
      if (!controller.signal.aborted) {
        posthog.capture('parts_list_opened', { piece_count: list.piece_count });
        onChoose(list);
      }
    } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
    finally { if (!controller.signal.aborted) setOpening(false); }
  }
  return <div className="saved-list-picker">
    {loading || opening ? <p role="status">{loading ? 'Loading lists…' : 'Opening list…'}</p> : null}
    {error && <p role="alert">{error} <button type="button" onClick={() => {
      posthog.capture('parts_lists_retry'); setAttempt(n => n + 1);
    }}>Try again</button></p>}
    {!loading && !error && !rows.length && <p>{page ? 'No more lists.' : 'No saved parts lists yet.'}</p>}
    <ul>{rows.map(row => <li key={row.id}><button type="button" disabled={opening || disabled} onClick={() => void open(row.id)}>
      <span>{row.name}</span><small>{row.piece_count.toLocaleString()} pieces</small>
    </button></li>)}</ul>
    {(page > 0 || rows.length === listsPerPage) && <div className="list-actions">
      {[-1, 1].map(step => <button key={step} type="button" disabled={loading || opening || (step < 0 ? page === 0 : rows.length < listsPerPage)}
        onClick={() => { posthog.capture('parts_lists_page_changed'); setPage(page + step); }}>{step < 0 ? 'Previous lists' : 'More lists'}</button>)}
    </div>}
  </div>;
}

export function SavedListImport({ onSelect, onLogin, disabled }: {
  onSelect: (inventory: PartsInventory) => void; onLogin?: () => void; disabled?: boolean;
}) {
  const { session } = useAuth();
  const [open, setOpen] = useState(false);
  return <section className="saved-list-import">
    <button type="button" className="previous-order-toggle" aria-expanded={open} disabled={disabled} onClick={() => {
      setOpen(!open); posthog.capture('existing_parts_saved_lists_toggled', { expanded: !open });
    }}><Layers size={19} /><span>Your parts lists</span><ChevronDown size={18} /></button>
    {open && (session?.user ? <>
      <SavedListPicker key={session.user.id} owner={session.user.id} disabled={disabled} onChoose={list => {
        posthog.capture('existing_parts_saved_list_imported', { piece_count: list.piece_count });
        onSelect({ name: list.name, source: 'upload', parts: list.parts });
      }} />
      <a href="/dashboard?tab=parts-lists" onClick={() => posthog.capture('existing_parts_manage_lists_clicked')}>Manage parts lists</a>
    </> : <button type="button" className="previous-order-tag" onClick={() => {
      posthog.capture('parts_lists_sign_in_clicked'); onLogin?.();
    }}>Sign in to see your lists</button>)}
  </section>;
}
