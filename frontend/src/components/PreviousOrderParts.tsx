import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Box, ChevronDown, Eye, Loader2, Package } from 'lucide-react';
import posthog from 'posthog-js';
import { useAuth } from '../contexts/AuthContext';
import { GetUserGenerationsApiService, type GenerationWithOrder, type OrderInfo } from '../services/getUserGenerationsApi';
import { PartsInventoryApi, inventoryQuantity, type PartsInventory } from '../services/partsInventoryApi';
import { getGeneratedModelPath } from '../utils/generationRoutes';
import './PreviousOrderParts.css';

const preview = (generation?: GenerationWithOrder, order?: OrderInfo) => generation?.preview_image_url
  || order?.image_url || generation?.processed_image_url || generation?.external_image_url;
function Preview({ image }: { image?: string }) {
  return <span className="previous-order-preview">{image ? <img src={image} alt="" loading="lazy" /> : <Box size={24} aria-hidden="true" />}</span>;
}

export function PreviousOrderParts(props: { onSelect: (inventory: PartsInventory) => void; onLogin?: () => void; disabled?: boolean }) {
  const { session, loading } = useAuth();
  return <OrderPicker key={session?.user?.id || 'guest'} {...props} token={session?.access_token} authLoading={loading} />;
}

function OrderPicker({ token, authLoading, onSelect, onLogin, disabled }: {
  token?: string; authLoading: boolean; onSelect: (inventory: PartsInventory) => void; onLogin?: () => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [orders, setOrders] = useState<OrderInfo[]>([]);
  const [generations, setGenerations] = useState<GenerationWithOrder[]>([]);
  const [selected, setSelected] = useState<OrderInfo | null>(null);
  const [inventory, setInventory] = useState<PartsInventory | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const historyRequest = useRef<AbortController | null>(null);
  const selectionRequest = useRef<AbortController | null>(null);
  const offset = useRef(0);
  useEffect(() => () => selectionRequest.current?.abort(), []);

  useEffect(() => {
    if (!open || authLoading) return;
    const controller = new AbortController(); historyRequest.current = controller;
    setLoading(true); setLoadingMore(false); setError(null); setOrders([]); setGenerations([]); setHasMore(false); offset.current = 0;
    void GetUserGenerationsApiService.getUserGenerations(token, 30, 0, false, controller.signal).then(page => {
      if (controller.signal.aborted) return;
      setOrders(page.all_orders.filter(order => !order.cancelled && order.id != null));
      setGenerations(page.generations); offset.current = page.generations.length; setHasMore(page.has_more);
    }).catch(() => { if (!controller.signal.aborted) setError('Could not load your orders. Please try again.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, authLoading, token, attempt]);

  const more = async () => {
    if (loadingMore || !historyRequest.current || historyRequest.current.signal.aborted) return;
    const signal = historyRequest.current.signal;
    setLoadingMore(true); setError(null);
    posthog.capture('existing_parts_previous_generations_more_clicked');
    try {
      const page = await GetUserGenerationsApiService.getUserGenerations(token, 30, offset.current, false, signal, false);
      if (signal.aborted) return;
      setGenerations(rows => [...rows, ...page.generations.filter(row => !rows.some(existing => existing.id === row.id))]);
      offset.current += page.generations.length; setHasMore(page.has_more && page.generations.length > 0);
    } catch { if (!signal.aborted) setError('Could not load more generations. Please try again.'); }
    finally { if (!signal.aborted) setLoadingMore(false); }
  };
  const selectOrder = async (order: OrderInfo) => {
    selectionRequest.current?.abort();
    const controller = new AbortController(); selectionRequest.current = controller;
    setSelected(order); setInventory(null); setSelectionError(null); setSelecting(true);
    posthog.capture('existing_parts_previous_order_selected', { order_id: order.id });
    try {
      const result = await PartsInventoryApi.order(order.id!, controller.signal);
      if (!controller.signal.aborted) setInventory(result.inventory);
    } catch (cause) {
      if (!controller.signal.aborted) setSelectionError(cause instanceof Error ? cause.message : 'Could not read this order’s parts list.');
    } finally { if (!controller.signal.aborted) setSelecting(false); }
  };
  const generationFor = (order: OrderInfo) => generations.find(row => row.id === order.generation_id);
  const orderName = (order: OrderInfo) => generationFor(order)?.name || order.prompt || generationFor(order)?.prompt || `Order #${order.id}`;
  const completed = generations.filter(row => row.status === 'completed' && row.endpoint !== 'uploadLdraw');

  return <section className="previous-order-parts" aria-label="Previous order parts">
    <button type="button" className="previous-order-toggle" aria-expanded={open} aria-controls="previous-order-options" disabled={disabled || authLoading}
      onClick={() => { posthog.capture('existing_parts_previous_orders_toggled', { expanded: !open }); setOpen(!open); }}>
      <Package size={19} aria-hidden="true" /><span>Your previous orders</span><ChevronDown size={18} aria-hidden="true" />
    </button>
    {open && <div id="previous-order-options" className="previous-order-options">
      {loading ? <p role="status" className="existing-parts-note">Loading your orders…</p> : <>
        {error && <p role="alert" className="existing-parts-error">{error} <button type="button" onClick={() => {
          posthog.capture('existing_parts_previous_orders_retry'); setAttempt(value => value + 1);
        }}>Try again</button></p>}
        {selected ? <div className="previous-order-selected">
          <div className="previous-order-row"><Preview image={preview(generationFor(selected), selected)} />
            <span className="previous-order-name"><strong>{orderName(selected)}</strong><small>Order #{selected.id}</small></span>
          </div>
          <div className="previous-order-actions">
            <a className="previous-order-tag" href={getGeneratedModelPath(selected.generation_id, true)} target="_blank" rel="noreferrer" onClick={() =>
              posthog.capture('existing_parts_order_model_viewed', { order_id: selected.id, generation_id: selected.generation_id })}><Eye size={15} aria-hidden="true" />View model</a>
            <button type="button" className="previous-order-tag" onClick={() => {
              selectionRequest.current?.abort(); setSelected(null); setInventory(null); setSelecting(false);
              posthog.capture('existing_parts_previous_order_change_clicked');
            }}>Change order</button>
          </div>
          {selecting && <p role="status" className="existing-parts-note"><Loader2 size={16} className="existing-parts-spinner" aria-hidden="true" /> Reading ordered parts…</p>}
          {selectionError && <p role="alert" className="existing-parts-error">{selectionError}</p>}
          {inventory && <button type="button" className="existing-parts-use" disabled={disabled} onClick={() => {
            posthog.capture('existing_parts_order_inventory_confirmed', { order_id: selected.id, piece_count: inventoryQuantity(inventory) }); onSelect(inventory);
          }}>Use these {inventoryQuantity(inventory).toLocaleString()} parts <ArrowRight size={16} aria-hidden="true" /></button>}
        </div> : orders.length > 0 ? <ul className="previous-order-list" aria-label="Your previous orders">
          {orders.map(order => <li key={order.id}><button type="button" className="previous-order-row" disabled={disabled} onClick={() => void selectOrder(order)}>
            <Preview image={preview(generationFor(order), order)} /><span className="previous-order-name"><strong>{orderName(order)}</strong><small>Order #{order.id}</small></span><ArrowRight size={17} aria-hidden="true" />
          </button></li>)}
        </ul> : !error && <>
          <p className="existing-parts-note">Make an order on brickbuilder.ai first, or choose from an existing set or upload a parts list below.</p>
          {!token && onLogin && <button type="button" className="previous-order-tag" onClick={() => {
            posthog.capture('existing_parts_orders_sign_in_clicked'); onLogin();
          }}>Sign in to see your orders</button>}
          <h2 className="previous-order-generations-title">Your previous generations</h2>
          {completed.length > 0 ? <ul className="previous-order-list" aria-label="Your previous generations">
            {completed.map(row => <li key={row.id} className="previous-order-row"><Preview image={preview(row)} />
              <span className="previous-order-name"><strong>{row.name || row.prompt || 'Your model'}</strong></span>
              <a href={`/order?id=${encodeURIComponent(row.id)}`} className="previous-order-tag" onClick={() =>
                posthog.capture('existing_parts_generation_order_clicked', { generation_id: row.id })}>Order</a>
            </li>)}
          </ul> : <p className="existing-parts-note">No completed models to order yet.</p>}
          {hasMore && <button type="button" className="previous-order-tag" disabled={loadingMore} onClick={() => void more()}>{loadingMore ? 'Loading…' : 'Show more generations'}</button>}
        </>}
      </>}
    </div>}
  </section>;
}
