import React from 'react';
import { Check, ChevronDown } from 'lucide-react';

export function CheckoutStep({ title, number, active, complete, disabled, onEdit, children }: {
  title: string; number: number; active: boolean; complete: boolean; disabled: boolean;
  onEdit: () => void; children: React.ReactNode;
}) {
  const id = `checkout-step-${number}`;
  return <section className={`checkout-step ${active ? 'is-active' : ''}`} aria-label={title}>
    {active ? <h2 className="checkout-step-title" id={`${id}-title`}>{title}</h2> :
      <button type="button" className={`checkout-step-bar ${complete ? 'is-complete' : ''}`}
        aria-expanded={false} aria-controls={id} disabled={disabled || !complete} onClick={onEdit}>
        <span className="checkout-step-marker" aria-label={complete ? 'Completed' : `Step ${number}`}>
          {complete ? <Check size={15} strokeWidth={2} /> : number}
        </span>
        <span>{title}</span>
        {complete && <ChevronDown size={23} className="checkout-step-chevron" />}
      </button>}
    <div id={id} hidden={!active} aria-labelledby={active ? `${id}-title` : undefined}>{children}</div>
  </section>;
}
