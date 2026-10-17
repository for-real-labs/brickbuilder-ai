import React, { useEffect, useRef } from 'react';
import { ArrowRight, X } from 'lucide-react';
import type { GetPriceResponse } from '../services/getPriceApi';
import { formatOrderPrice, getOrderPricing } from '../utils/orderCheckout';
import './MobileModelOrderBar.css';

interface Props {
  quote: GetPriceResponse | null;
  loading: boolean;
  updating: boolean;
  error: string | null;
  onOrder: () => void;
  onDismiss: () => void;
  onHeightChange?: (height: number) => void;
}

export function MobileModelOrderBar({ quote, loading, updating, error, onOrder, onDismiss, onHeightChange }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const pricing = getOrderPricing(quote);
  useEffect(() => {
    if (!onHeightChange) return;
    const measure = () => onHeightChange(ref.current?.getBoundingClientRect().height ?? 0);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (ref.current) observer?.observe(ref.current);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); onHeightChange(0); };
  }, [onHeightChange]);

  return <div ref={ref} className="model-mobile-order" aria-label="Order your brick kit">
    <button type="button" className="model-mobile-order-dismiss" aria-label="Dismiss order banner" onClick={onDismiss}>
      <X size={18} aria-hidden="true" />
    </button>
    <div><strong>{loading ? 'Pricing…' : pricing ? formatOrderPrice(pricing.totalCents) : '—'}</strong>
      <span>{error || (!loading && !pricing) ? 'Price unavailable right now' : 'Shipping included'}</span></div>
    <button type="button" aria-label="Order this model" className="model-order-button"
      disabled={loading || updating || !!error || !pricing} onClick={onOrder}>
      Order my kit <ArrowRight size={18} aria-hidden="true" />
    </button>
  </div>;
}
