import React, { useRef, useState } from 'react';
import posthog from 'posthog-js';
import { Camera, FileInput, Pencil } from 'lucide-react';
import { InventorySources } from './ExistingPartsDesigner';
import { PartEntry, colorLabel } from './PartEntry';
import { SavedListPicker } from './SavedListPicker';
import { mergeParts, SavedLists, SaveConflict, type SavedPartsList } from '../services/savedPartsLists';
import type { InventoryPart } from '../services/partsInventoryApi';
import './SavedPartsLists.css';

const modes = [
  { id: 'manual', label: 'Enter a part', icon: Pencil },
  { id: 'photo', label: 'Scan one part', icon: Camera },
  { id: 'import', label: 'Import parts', icon: FileInput },
] as const;

function PartsListEditor({ owner, existing, scanner = false, onClose }: {
  owner: string; existing?: SavedPartsList; scanner?: boolean; onClose?: () => void;
}) {
  const [id, setId] = useState(() => existing?.id ?? crypto.randomUUID());
  const [revision, setRevision] = useState(existing?.revision);
  const [name, setName] = useState(existing?.name ?? (scanner ? 'Bulk bin parts' : ''));
  const [parts, setParts] = useState<InventoryPart[]>(existing?.parts ?? []);
  const latestParts = useRef(parts);
  const [page, setPage] = useState(0);
  const [mode, setMode] = useState<typeof modes[number]['id']>(scanner ? 'photo' : 'manual');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const count = parts.reduce((n, row) => n + row.quantity, 0);
  const pageSize = 20;
  function changeParts(next: InventoryPart[]) {
    latestParts.current = next;
    setParts(next); setDirty(true); setError('');
    setPage(p => Math.min(p, Math.max(0, Math.ceil(next.length / pageSize) - 1)));
  }
  function add(rows: InventoryPart[]) {
    try {
      changeParts(mergeParts(latestParts.current, rows));
      const quantity = rows.reduce((n, row) => n + row.quantity, 0);
      setNotice(`Added ${quantity.toLocaleString()} ${quantity === 1 ? 'piece' : 'pieces'}.`);
      return true;
    } catch (e) { setError((e as Error).message); setNotice(''); return false; }
  }
  async function save(copy: boolean) {
    const targetId = copy ? crypto.randomUUID() : id;
    if (copy) { setId(targetId); setRevision(undefined); setConflict(false); }
    setSaving(true); setError(''); setNotice('');
    try {
      const result = await SavedLists.save(owner, targetId, copy ? undefined : revision, name, latestParts.current);
      setRevision(result.revision); setName(result.name); setDirty(false); setConflict(false);
      setNotice('Saved to Your parts lists.');
      posthog.capture('parts_list_saved', { piece_count: result.piece_count, source: scanner ? 'scanner' : 'dashboard' });
    } catch (e) {
      setConflict(e instanceof SaveConflict); setError((e as Error).message);
    } finally { setSaving(false); }
  }
  return <div className="parts-list-editor">
    <fieldset disabled={saving}>
      <label className="list-name">List name<input value={name} maxLength={200} placeholder="e.g. Saturday bulk bin" onChange={e => {
        setName(e.target.value); setDirty(true); setNotice('');
      }} /></label>
      {!scanner && <div className="list-modes" aria-label="Add parts">
        {modes.map(({ id, label, icon: Icon }) => <button type="button" key={id} aria-pressed={mode === id} onClick={() => {
          setMode(id); setError(''); posthog.capture('parts_list_input_selected', { mode: id });
        }}><Icon size={16} />{label}</button>)}
      </div>}
      {mode === 'import' ? !saving && <InventorySources onSelect={inventory => {
        if (add(inventory.parts)) {
          setName(value => value.trim() ? value : inventory.name);
          setMode('manual'); posthog.capture('parts_list_inventory_added', { source: inventory.source });
        }
      }} /> : <PartEntry key={mode} scan={mode === 'photo'} onAdd={add} />}
      <div className="list-totals"><strong>{count.toLocaleString()} {count === 1 ? 'piece' : 'pieces'}</strong>
        <span>{parts.length.toLocaleString()} part/color {parts.length === 1 ? 'pair' : 'pairs'}</span></div>
      {parts.length > 0 && <ul className="list-contents" aria-label="Parts in this list">
        {parts.slice(page * pageSize, (page + 1) * pageSize).map((row, index) => <li key={row.part_id + ':' + row.color_id}>
          <span><strong>{row.part_id}</strong><small>{colorLabel(row.color_id)}</small></span>
          <b>×{row.quantity.toLocaleString()}</b>
          <button type="button" aria-label={`Remove ${row.part_id} in ${colorLabel(row.color_id)}`} onClick={() => {
            changeParts(parts.filter((_, i) => i !== page * pageSize + index)); setNotice('Removed from list.');
            posthog.capture('parts_list_row_removed');
          }}>Remove</button>
        </li>)}
      </ul>}
      {parts.length > pageSize && <div className="list-actions">
        {[-1,1].map(step => <button key={step} type="button" disabled={step < 0 ? page === 0 : (page + 1) * pageSize >= parts.length}
          onClick={() => { setPage(page + step); posthog.capture('parts_list_contents_page_changed'); }}>{step < 0 ? 'Previous parts' : 'More parts'}</button>)}
      </div>}
      <div className="list-actions">
        <button className="parts-list-primary" disabled={!dirty || !parts.length || !name.trim()} onClick={() => void save(conflict)}>
          {saving ? 'Saving…' : conflict ? 'Save as a separate list' : 'Save list'}
        </button>
        {onClose && <button onClick={() => {
          if (!dirty || window.confirm('Discard unsaved changes to this list?')) {
            posthog.capture('parts_list_editor_closed'); onClose();
          }
        }}>Back to your lists</button>}
        {scanner && revision && <a href="/dashboard?tab=parts-lists" onClick={() => posthog.capture('parts_list_dashboard_clicked')}>View in dashboard</a>}
      </div>
    </fieldset>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

export function ScannerPartsList({ owner }: { owner: string }) {
  const [open, setOpen] = useState(false);
  const [started, setStarted] = useState(false);
  return <section className="single-part-scanner">
    <button type="button" aria-expanded={open} className="scan-list-toggle" onClick={() => {
      setStarted(true); setOpen(!open); posthog.capture('photo_scanner_single_part_toggled', { expanded: !open });
    }}><Camera size={20} /><span><strong>Single-part scanner</strong><small>Identify a brick with Brickognize and count it into a parts list.</small></span>
      <b aria-hidden="true">{open ? '−' : '+'}</b></button>
    <div hidden={!open}>{started && <PartsListEditor owner={owner} scanner />}</div>
  </section>;
}

export function DashboardPartsLists({ owner }: { owner?: string }) {
  const [editor, setEditor] = useState<SavedPartsList | 'new'>();
  return <section className="dashboard-parts-lists">
    <header><h1>Your parts lists</h1>{owner && !editor && <button className="parts-list-primary" onClick={() => {
      setEditor('new'); posthog.capture('parts_list_create_clicked');
    }}>Create parts list</button>}</header>
    {!owner ? <p>Sign in to save parts lists to your account.</p> : editor
      ? <PartsListEditor owner={owner} existing={editor === 'new' ? undefined : editor} onClose={() => setEditor(undefined)} />
      : <SavedListPicker owner={owner} onChoose={setEditor} />}
  </section>;
}
