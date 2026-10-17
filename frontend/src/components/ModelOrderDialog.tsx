import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { GetPriceResponse } from '../services/getPriceApi';
import { ModelOrderCard } from './ModelOrderCard';
import './ModelOrderDialog.css';

export function ModelOrderDialog({ modelName, quote, loading, updating, error, onOrder, onDismiss, returnFocusRef }: {
  modelName: string;
  quote: GetPriceResponse | null;
  loading: boolean;
  updating: boolean;
  error: string | null;
  onOrder: () => void;
  onDismiss: () => void;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const trigger = returnFocusRef.current;
    dialog?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      if (dialog?.open) dialog.close();
      document.body.style.overflow = overflow;
      if (trigger?.isConnected) trigger.focus();
    };
  }, [returnFocusRef]);

  return createPortal(<dialog ref={ref} className="model-order-dialog" aria-label={`Order ${modelName}`}
    onCancel={event => { event.preventDefault(); onDismiss(); }} onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onDismiss();
    }}>
    <div className="model-order-dialog-heading">
      <button type="button" aria-label="Close order popup" onClick={onDismiss}><X size={20} aria-hidden="true" /></button>
      <p>{modelName}</p>
    </div>
    <ModelOrderCard quote={quote} loading={loading} updating={updating} error={error}
      onOrder={onOrder} showMobileBar={false} />
  </dialog>, document.body);
}
