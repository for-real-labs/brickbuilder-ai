import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import './ModelOrderDialog.css';

export function KitConversionDialog({ credits, onCancel, onConfirm }: {
  credits: number; onCancel: () => void; onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const trigger = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  return createPortal(
    <dialog ref={ref} className="model-order-dialog kit-conversion-dialog" aria-labelledby="kit-conversion-title"
      onCancel={event => { event.preventDefault(); onCancel(); }}>
      <h2 id="kit-conversion-title">Some parts aren’t in our inventory</h2>
      <p>Would you like to convert them to the closest matching parts? You can review the updated model and final price before ordering.</p>
      <div>
        <button type="button" className="kit-conversion-cancel" onClick={onCancel} autoFocus>Cancel</button>
        <button type="button" className="model-order-button" onClick={onConfirm}>
          Convert for {credits} {credits === 1 ? 'credit' : 'credits'}
        </button>
      </div>
    </dialog>, document.body,
  );
}
