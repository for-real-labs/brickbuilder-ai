import React, { useEffect, useId, useRef, useState } from 'react';
import { Box, ChevronDown, Image, Users, Wrench } from 'lucide-react';
import { Link } from 'react-router-dom';
import posthog from 'posthog-js';
import { PetSwitchButton } from './PetCompanion';

const tools = [
  { label: 'Image to LEGO', path: '/image-to-lego', icon: Image, event: 'landing_header_image_to_lego_clicked' },
  { label: 'GLB to LEGO', path: '/glb-to-lego', icon: Box, event: 'landing_header_glb_to_lego_clicked' },
  { label: 'OBJ to LEGO', path: '/obj-to-lego', icon: Box, event: 'landing_header_obj_to_lego_clicked' },
  { label: 'Upload LDraw', path: '/use-ai-to-edit-ldraw', icon: Box, event: 'landing_header_upload_ldraw_clicked' },
  { label: 'Community', path: '/community', icon: Users, event: 'landing_header_community_clicked' },
];

export function LandingToolsMenu({ page }: { page: string }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const attribution = () => ({ page, navigation_layout: 'tools_dropdown' });

  useEffect(() => {
    setOpen(false);
    posthog.capture('landing_header_tools_shown', { page, navigation_layout: 'tools_dropdown' });
  }, [page]);

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismissOutside);
    return () => document.removeEventListener('pointerdown', dismissOutside);
  }, [open]);

  return <div ref={container} className="relative" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={event => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    }
  }}>
    <button ref={trigger} type="button" aria-expanded={open} aria-controls={panelId}
      className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-full border border-slate-200 bg-white/90 px-3 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:border-red-200 hover:bg-red-50 hover:text-[#f44336] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f44336] focus-visible:ring-offset-2"
      onClick={() => {
        if (!open) posthog.capture('landing_header_tools_opened', attribution());
        setOpen(!open);
      }}>
      <Wrench aria-hidden="true" className="h-4 w-4" />Tools
      <ChevronDown aria-hidden="true" className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
    {open && <div id={panelId} className="absolute left-1/2 top-full z-[60] mt-2 w-56 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-xl">
      <ul aria-label="Tools" className="m-0 list-none p-0">
        {tools.map(({ label, path, icon: Icon, event }) => <li key={path}>
          <Link to={path} className="flex min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-red-50 hover:text-[#f44336] focus-visible:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#f44336]"
            onClick={() => {
              const properties = { ...attribution(), destination: path, tool: label };
              posthog.capture('landing_header_tools_item_clicked', properties);
              posthog.capture(event, properties);
              setOpen(false);
            }}>
            <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />{label}
          </Link>
        </li>)}
        <li className="mt-1 border-t border-slate-100 pt-1">
          <PetSwitchButton source="landing_tools" returnFocusRef={trigger} onOpen={() => setOpen(false)}
            className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-red-50 hover:text-[#f44336] focus-visible:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#f44336]" />
        </li>
      </ul>
    </div>}
  </div>;
}
