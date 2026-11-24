import React, { useState } from 'react';
import posthog from 'posthog-js';
import type { InventoryPart } from '../services/partsInventoryApi';
import type { RecognizedPart } from '../services/brickognizeApi';
import { PartsImageRecognition } from './PartsImageRecognition';

const colors: Record<number, string> = {
  0: 'Black', 1: 'Blue', 2: 'Green', 4: 'Red', 6: 'Brown', 7: 'Light gray', 8: 'Dark gray',
  14: 'Yellow', 15: 'White', 19: 'Tan', 25: 'Orange', 28: 'Dark tan', 47: 'Clear',
  70: 'Reddish brown', 71: 'Light bluish gray', 72: 'Dark bluish gray',
};
export const colorLabel = (id: number) => colors[id] || `LDraw ${id}`;

export function PartEntry({ scan, onAdd }: { scan: boolean; onAdd: (parts: InventoryPart[]) => boolean }) {
  const [match, setMatch] = useState<RecognizedPart | null>(null);
  const [id, setId] = useState('');
  const [color, setColor] = useState('');
  const [customColor, setCustomColor] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [scanNumber, setScanNumber] = useState(0);
  return <>
    {scan && <PartsImageRecognition key={scanNumber} onMatch={part => {
      setMatch(part); setId(part?.id ?? ''); setQuantity('1'); setColor(''); setCustomColor('');
    }} />}
    {(!scan || match) && <form className="part-entry" onSubmit={event => {
      event.preventDefault();
      const row = { part_id: id, color_id: Number(color === 'custom' ? customColor : color), quantity: Number(quantity) };
      if (onAdd([row])) {
        posthog.capture('parts_list_part_added', { source: scan ? 'photo' : 'manual', quantity: row.quantity });
        setId(''); setQuantity('1'); setColor(''); setCustomColor(''); setMatch(null); setScanNumber(n => n + 1);
      }
    }}>
      {scan && match && <div className="part-entry-match" role="status">
        {match.imageUrl && <img src={match.imageUrl} alt="" referrerPolicy="no-referrer" />}
        <span><strong>{match.name}</strong><small>Confirm the part, color, and quantity below.</small></span>
      </div>}
      <label>Part number<input required value={id} maxLength={84} placeholder="e.g. 3001" onChange={e => setId(e.target.value)} /></label>
      <label>Color<select aria-label="Color" required value={color} onChange={e => setColor(e.target.value)}>
        <option value="">Choose color</option>
        {Object.entries(colors).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
        <option value="custom">Other LDraw color…</option>
      </select></label>
      {color === 'custom' && <label>LDraw color ID<input required type="number" min="0" max="65535" value={customColor} onChange={e => setCustomColor(e.target.value)} /></label>}
      <label>Quantity<input required inputMode="numeric" type="number" min="1" max="100000" value={quantity} onFocus={e => e.target.select()} onChange={e => setQuantity(e.target.value)} /></label>
      <button className="parts-list-primary" type="submit">Add to list</button>
    </form>}
  </>;
}
