import React from 'react';
import posthog from 'posthog-js';
import type { BasicInventoryCompatibility } from '../services/partsInventoryApi';

export function BasicInventorySummary({ result, error, loading }: {
  result?: BasicInventoryCompatibility; error?: string; loading: boolean;
}) {
  if (loading) return <p role="status">Checking which pieces work in Basic bricks mode…</p>;
  if (error) return <p role="alert">{error} Choose All parts or upload the list again.</p>;
  if (!result) return null;
  return <div className="w-full max-w-xl text-center" role="status">
    <p>{result.available_count.toLocaleString()} pieces available in Basic bricks mode · {result.unavailable_count.toLocaleString()} outside its palette.</p>
    {result.unavailable_count > 0 && <details className="mt-2" onToggle={event => {
      if (event.currentTarget.open) posthog.capture('existing_parts_basic_unavailable_expanded');
    }}>
      <summary className="cursor-pointer">See excluded pieces</summary>
      <ul className="mx-auto mt-2 max-h-32 w-fit overflow-auto text-left">
        {result.unavailable.map(part => <li key={part.part_id + '-' + part.color_id}>{part.quantity.toLocaleString()} × {part.part_id}, LDraw color {part.color_id}</li>)}
      </ul>
    </details>}
    {result.available_count === 0
      ? <p className="mt-2">Choose All parts to design with this inventory.</p>
      : result.unavailable_count > 0 && <p className="mt-2">Only the available pieces will be used. Choose All parts to use the full inventory.</p>}
  </div>;
}
