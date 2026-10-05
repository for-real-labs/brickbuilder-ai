import React from 'react';
import { ArrowRight, Package, Truck } from 'lucide-react';
import type { GetPriceResponse } from '../services/getPriceApi';
import { formatOrderPrice, getOrderPricing } from '../utils/orderCheckout';

interface Props {
  quote: GetPriceResponse | null;
  loading: boolean;
  updating: boolean;
  error: string | null;
  onOrder: (source: 'card' | 'mobile_bar') => void;
  onResize?: () => void;
}

export function ModelOrderCard({ quote, loading, updating, error, onOrder, onResize }: Props) {
  const pricing = getOrderPricing(quote);
  const unavailable = loading || updating || !!error || !pricing;
  const price = pricing ? formatOrderPrice(pricing.totalCents) : '—';
  const status = loading ? 'Calculating your kit price…' : error || !pricing ? 'Price unavailable right now.' : null;

  return <>
    <section className="model-order-card" aria-label="Your brick kit">
      <div className="model-order-heading">
        <span className="model-order-icon"><Package size={20} aria-hidden="true" /></span>
        <div><h2>Bring it to life</h2><p>Your model, delivered as a brick kit.</p></div>
      </div>
      <div className="model-order-price">
        <div><span className="model-order-total">{price}</span>{pricing && <span className="model-order-original">{formatOrderPrice(pricing.fullTotalCents)}</span>}</div>
        <span>USD · shipping included</span>
      </div>
      {pricing && <p className="model-launch-discount">50% off · BrickBuilder Launch Discount</p>}
      {status && <p role="status" className="model-order-status">{status}</p>}
      {updating && <p role="status" className="model-order-status">Your kit will be ready to order when the update finishes.</p>}
      <button type="button" aria-label="Order my kit" className="model-order-button" disabled={unavailable} onClick={() => onOrder('card')}>
        Order my kit <ArrowRight size={19} aria-hidden="true" />
      </button>
      <div className="model-kit-details">
        {quote && <span><Package size={14} aria-hidden="true" />{quote.total_parts.toLocaleString()} Pieces</span>}
        <span><Truck size={14} aria-hidden="true" />8–12 business days</span>
      </div>
      {onResize && <button type="button" className="model-resize-link" onClick={onResize} disabled={unavailable}>Adjust size &amp; price</button>}
    </section>
    <div className="model-mobile-order" aria-label="Order your brick kit">
      <div><strong>{loading ? 'Pricing…' : price}</strong><span>Shipping included</span></div>
      <button type="button" aria-label="Order this model" className="model-order-button" disabled={unavailable} onClick={() => onOrder('mobile_bar')}>
        Order my kit <ArrowRight size={18} aria-hidden="true" />
      </button>
    </div>
  </>;
}
