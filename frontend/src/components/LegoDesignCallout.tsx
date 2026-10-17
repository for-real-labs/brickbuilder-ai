import React from 'react';
import { Link } from 'react-router-dom';
import { Blocks } from 'lucide-react';
import posthog from 'posthog-js';

export function LegoDesignCallout({ page }: { page: string }) {
  return <aside aria-label="Design LEGO models" className="mt-8 rounded-2xl border border-red-100 bg-red-50/80 p-5 text-left sm:p-6">
    <div className="flex items-start gap-3">
      <Blocks className="mt-1 h-6 w-6 shrink-0 text-[#f44336]" aria-hidden="true" />
      <div>
        <h2 className="text-lg font-bold text-slate-900">Try designing LEGO models with AI</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">Turn 3D objects, images, or text prompts into LEGO-compatible designs. Preview your build and explore building files and parts lists.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {[[ '/glb-to-lego', 'From a 3D object' ], [ '/image-to-lego', 'From an image' ], [ '/#landing-build-prompt', 'From a text prompt' ]].map(([destination, label]) =>
            <Link key={destination} to={destination} onClick={() => posthog.capture('converter_lego_design_clicked', { page, destination })}
              className="rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-[#c42d23] transition-colors hover:bg-red-100">{label}</Link>)}
        </div>
      </div>
    </div>
  </aside>;
}
