import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import posthog from 'posthog-js';
import { useAuth } from '../contexts/AuthContext';
import { GetPriceApiService, type GetPriceResponse } from '../services/getPriceApi';
import type { LandingModel } from '../hooks/useLandingModel';
import { MobileModelOrderBar } from './MobileModelOrderBar';
import { ModelOrderCard } from './ModelOrderCard';
import { getOrderPricing } from '../utils/orderCheckout';

export function LandingModelOrdering({ model, busy, showMobileBar, onDismiss, onHeightChange }: {
  model: LandingModel; busy: boolean; showMobileBar: boolean; onDismiss: () => void; onHeightChange?: (height: number) => void;
}) {
  const { session } = useAuth();
  const navigate = useNavigate();
  const [quote, setQuote] = useState<GetPriceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const id = model.generation.generation_id;
  useEffect(() => {
    let disposed = false;
    setQuote(null); setLoading(true); setError(null);
    void GetPriceApiService.getPrice(id, session?.access_token).then(result => {
      if (!disposed) setQuote(result);
    }).catch(() => {
      if (!disposed) setError('Price unavailable right now');
    }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [id, session?.access_token]);

  const order = (source: 'mobile_bar' | 'card') => {
    if (loading || busy || error || !getOrderPricing(quote)) return;
    posthog.capture('landing_model_order_clicked', { generation_id: id, source });
    const image = model.generation.preview_image_url || model.generation.processed_image_url || model.generation.external_image_url;
    navigate('/order', { state: {
      generation_id: id, name: model.generation.name || model.generation.prompt || 'Your model',
      parts_list: quote?.parts_breakdown || [], priceData: quote,
      ...(image ? { screenshots: { angle1: image } } : {}),
    } });
  };
  return <>
    <aside className="landing-desktop-order" aria-label="Order pane">
      <ModelOrderCard quote={quote} loading={loading} updating={busy} error={error}
        onOrder={() => order('card')} showMobileBar={false} />
    </aside>
    {showMobileBar && <MobileModelOrderBar quote={quote} loading={loading} updating={busy} error={error}
      onHeightChange={onHeightChange} onDismiss={onDismiss} onOrder={() => order('mobile_bar')} />}
  </>;
}
