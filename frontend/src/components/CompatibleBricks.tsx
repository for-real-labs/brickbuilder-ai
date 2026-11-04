import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info, X } from 'lucide-react';
import posthog from 'posthog-js';
import './CompatibleBricks.css';

export function CompatibleBricks({ source }: { source: string }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  const close = () => {
    dialog.current?.close();
    setOpen(false);
    trigger.current?.focus();
    posthog.capture('order_brick_compatibility_closed', { source });
  };

  return <>
    <span className="compatible-bricks-label">LEGO® compatible bricks<button ref={trigger} type="button"
      className="compatible-bricks-info" aria-label="About LEGO® compatible bricks" aria-haspopup="dialog" aria-expanded={open}
      onClick={() => { setOpen(true); posthog.capture('order_brick_compatibility_opened', { source }); }}>
      <Info size={16} aria-hidden="true" />
    </button></span>
    {open && createPortal(<dialog ref={dialog} className="compatible-bricks-dialog" aria-labelledby={titleId} aria-describedby={descriptionId}
      onCancel={event => { event.preventDefault(); close(); }}
      onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <div className="compatible-bricks-content">
        <button type="button" className="compatible-bricks-close" aria-label="Close brick information" onClick={close}><X size={20} aria-hidden="true" /></button>
        <h2 id={titleId}>About your bricks</h2>
        <div id={descriptionId}>
          <p>Gobricks are used instead of LEGO® bricks. They are 100% compatible with LEGO®.</p>
          <p>If you require LEGO® bricks, please download the parts list in Tools → Export and upload it to BrickLink or BrickOwl.</p>
        </div>
        <button type="button" className="compatible-bricks-done" onClick={close}>Got it</button>
      </div>
    </dialog>, document.body)}
  </>;
}
