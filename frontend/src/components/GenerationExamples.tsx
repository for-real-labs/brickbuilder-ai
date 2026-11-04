import React from 'react';

import { Link } from 'react-router-dom';
import posthog from 'posthog-js';

const examples = [
  { name: 'Santa’s Workshop', id: '3164643e-974e-452a-8819-a1cc7788a628' },
  { name: 'Lighthouse', id: '4e5a6629-bdd4-46d0-97cc-d7271691e60c' },
  { name: 'Tiger', id: '126a7995-3bfe-4744-8008-c9eb39d386f5' },
];

export function GenerationExamples({ onView }: { onView: () => void }) {
  return <section className="mt-5 border-t border-slate-200 pt-4" aria-labelledby="generation-examples-title">
    <h2 id="generation-examples-title" className="mb-3 text-base font-bold text-slate-900">See what you can build</h2>
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {examples.map(({ name, id }) => <li key={id} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <img src={`/share-image/${id}.png`} alt="" loading="lazy" className="aspect-video w-full bg-slate-50 object-contain" />
        <div className="flex flex-wrap items-center justify-between gap-2 p-3">
          <h3 className="text-sm font-semibold text-slate-900">{name}</h3>
          <Link to={`/?id=${id}`} className="rounded-lg bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-200"
            aria-label={`View model: ${name}`} onClick={() => {
              posthog.capture('generation_subscription_example_clicked', { generation_id: id });
              onView();
            }}>View model</Link>
        </div>
      </li>)}
    </ul>
  </section>;
}
