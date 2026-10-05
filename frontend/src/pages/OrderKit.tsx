import React from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowRight, Check, ChevronDown, LockKeyhole, Package, Truck } from "lucide-react";
import posthog from "posthog-js";
import { CreateCheckoutSessionApiService, type CreateCheckoutSessionResponse } from "../services/createCheckoutSessionApi";
import { GetPriceApiService } from "../services/getPriceApi";
import { ThreeLDRViewer } from "../components/ThreeLDRViewer";
import { GetGenerationApiService } from "../services/getGenerationApi";
import { LdrToMpdApiService } from "../services/ldrToMpdApi";
import { SEO } from "../components/SEO";
import { CheckoutStep } from "../components/checkout/CheckoutStep";
import { CheckoutPayment } from "../components/checkout/CheckoutPayment";
import { supabase } from "../lib/supabase";
import { getOrderReturnModelPath } from "../utils/generationRoutes";
import { getOrderPricing, formatOrderPrice, type DeliveryDetails, type OrderQuote } from "../utils/orderCheckout";
import "./OrderKit.css";

type LocationState = {
  name?: string;
  parts_list?: { quantity: number }[];
  screenshots?: { angle1: string; angle2?: string };
  generation_id?: string;
  cart_id?: string;
  priceData?: OrderQuote;
};

function restoreOrderState(navigationState: LocationState | null): LocationState {
  if (navigationState) return navigationState;
  try {
    const saved = JSON.parse(localStorage.getItem('orderState') || '{}');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  }
  catch { return {}; }
}

const emptyDelivery: DeliveryDetails = { email: '', name: '', line1: '', line2: '', city: '', region: '', postalCode: '' };
const stepNames = ['Contact & delivery', 'Payment'];

export default function OrderKit() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = React.useMemo(() => restoreOrderState(location.state as LocationState | null), [location.state]);
  const lastGenerationId = localStorage.getItem('lastGenerationId');
  const generationId = state.generation_id || lastGenerationId || undefined;
  const [resolvedName, setResolvedName] = React.useState<string | null>(null);
  const [allParts, setAllParts] = React.useState(false);
  const name = resolvedName || state.name || 'Your Model';
  const [mpdContent, setMpdContent] = React.useState<string | null>(null);
  const [modelLoading, setModelLoading] = React.useState(false);
  const [quote, setQuote] = React.useState<OrderQuote | null>(state.priceData || null);
  const [quoteLoading, setQuoteLoading] = React.useState(false);
  const [quoteError, setQuoteError] = React.useState(false);
  const [quoteAttempt, setQuoteAttempt] = React.useState(0);
  const pricing = getOrderPricing(quote);
  const [step, setStep] = React.useState(0);
  const [country, setCountry] = React.useState<'US' | 'CA'>('US');
  const [delivery, setDelivery] = React.useState<DeliveryDetails>(emptyDelivery);
  const [session, setSession] = React.useState<CreateCheckoutSessionResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [showApartment, setShowApartment] = React.useState(false);
  const [summaryExpanded, setSummaryExpanded] = React.useState(false);
  const stepFocusRef = React.useRef<HTMLDivElement>(null);
  const publishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || '';
  const partsCount = quote?.total_parts ?? (Array.isArray(state.parts_list) ? state.parts_list.reduce((sum, part) => sum + (Number.isFinite(part.quantity) ? part.quantity : 0), 0) : undefined);

  React.useEffect(() => {
    // Only cache model/order data. Contact details and payment secrets stay in memory.
    try { localStorage.setItem('orderState', JSON.stringify({ ...state, priceData: quote || undefined, generation_id: generationId })); } catch { /* Checkout still works without storage. */ }
  }, [state, quote, generationId]);

  React.useEffect(() => {
    if (getOrderPricing(state.priceData)) { setQuote(state.priceData!); return; }
    if (!generationId) return;
    let disposed = false;
    setQuoteLoading(true); setQuoteError(false);
    void (async () => {
      try {
        const token = (await supabase.auth.getSession()).data.session?.access_token;
        const data = await GetPriceApiService.getPrice(generationId, token);
        if (!getOrderPricing(data)) throw new Error('No valid quote');
        if (!disposed) setQuote(data);
      } catch {
        if (!disposed) { setQuoteError(true); posthog.capture('order_checkout_error', { generation_id: generationId, stage: 'pricing' }); }
      } finally { if (!disposed) setQuoteLoading(false); }
    })();
    return () => { disposed = true; };
  }, [generationId, state.priceData, quoteAttempt]);

  React.useEffect(() => {
    if (step > 0) {
      stepFocusRef.current?.focus({ preventScroll: true });
      stepFocusRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    }
  }, [step]);

  // Fetch model content for 3D preview
  React.useEffect(() => {
    const controller = new AbortController();
    setResolvedName(null);
    setAllParts(false);
    const fetchModelContent = async () => {
      if (!generationId) {
        // Try to get from localStorage as fallback
        const storedMpd = localStorage.getItem('MPD_CONTENT') || localStorage.getItem('lastMpdContent');
        if (storedMpd) {
          setMpdContent(storedMpd);
        }
        return;
      }

      setModelLoading(true);
      try {
        const generationData = await GetGenerationApiService.getGeneration(generationId, controller.signal);
        if (controller.signal.aborted) return;
        const fetchedName = generationData.name || generationData.prompt || state.name || "Your Model";
        setResolvedName(fetchedName);
        setAllParts(generationData.mode === 'all_parts' || generationData.endpoint === 'novaToBricks');
        
        // Get MPD content from URL or convert LDR to MPD (same as GeneratedModel)
        let mpdContent: string | null = null;
        
        if (generationData.mpd_url) {
          try {
            const mpdResponse = await fetch(generationData.mpd_url, { signal: controller.signal });
            if (mpdResponse.ok) {
              mpdContent = await mpdResponse.text();
            }
          } catch (mpdError) {
            console.warn('Failed to fetch MPD from URL:', mpdError);
          }
        }
        
        // If no MPD from URL, try converting LDR to MPD
        if (!mpdContent && generationData.ldr_content) {
          try {
            const modelName = fetchedName;
            const authToken = (await supabase.auth.getSession()).data.session?.access_token;
            const mpdData = await LdrToMpdApiService.convertLdrToMpd(
              generationData.ldr_content,
              modelName,
              authToken
            );
            mpdContent = mpdData.mpd_content;
          } catch (mpdError) {
            console.warn('Failed to convert LDR to MPD:', mpdError);
          }
        }
        
        if (mpdContent && !controller.signal.aborted) {
          setMpdContent(mpdContent);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error('Failed to fetch model content:', error);
        // Try localStorage as fallback
        const storedMpd = localStorage.getItem('MPD_CONTENT') || localStorage.getItem('lastMpdContent');
        if (storedMpd) {
          setMpdContent(storedMpd);
        }
      } finally {
        if (!controller.signal.aborted) setModelLoading(false);
      }
    };

    void fetchModelContent();
    return () => controller.abort();
  }, [generationId, state.name]);


  const goToStep = (next: number) => {
    if (loading) return;
    setError(null); setSession(null); setStep(next);
    posthog.capture('order_step_changed', { generation_id: generationId, step: stepNames[next], direction: next > step ? 'forward' : 'back' });
  };

  const startPayment = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (loading || !pricing || !generationId) return;
    setLoading(true); setError(null);
    posthog.capture('order_delivery_completed', { generation_id: generationId, country });
    try {
      if (!publishableKey) throw new Error('Payment configuration unavailable');
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const data = await CreateCheckoutSessionApiService.createCheckoutSession({
        name, priceCents: pricing.totalCents, quantity: 1,
        generationId, brickowlCartId: state.cart_id || localStorage.getItem('current_cart_id') || undefined,
        uiMode: 'elements',
      }, token);
      if (!data.client_secret) throw new Error('Embedded payment unavailable');
      if (data.price_data) setQuote(data.price_data);
      setSession(data); setStep(1);
      posthog.capture('order_step_changed', { generation_id: generationId, step: 'Payment', direction: 'forward' });
    } catch {
      setError('We couldn’t start payment. Your details are still here — please try again.');
      posthog.capture('order_checkout_error', { generation_id: generationId, stage: 'session' });
    } finally { setLoading(false); }
  };

  const field = (key: keyof DeliveryDetails, label: string, autoComplete: string, optional = false) =>
    <label className={`checkout-field ${['email', 'name', 'line1', 'line2'].includes(key) ? 'checkout-field-full' : ''}`}>
      <span>{label}{optional && <span className="checkout-optional"> (optional)</span>}</span>
      <input name={key} type={key === 'email' ? 'email' : 'text'} autoComplete={autoComplete}
        required={!optional} maxLength={key === 'email' ? 254 : 200} disabled={loading}
        value={delivery[key]} onChange={event => setDelivery(current => ({ ...current, [key]: event.target.value }))}
        onBlur={event => setDelivery(current => ({ ...current, [key]: event.target.value.trim() }))} />
    </label>;

  return <div className="order-checkout">
    <SEO title={`Order Kit — ${name}`} description="Review and order your custom brick kit." url="https://brickbuilder.ai/order" noIndex />
    <header className="checkout-header"><div className="checkout-header-inner">
      <Link to="/" aria-label="BrickBuilder home" className="checkout-brand"><span><b>BRICK</b>BUILDER</span></Link>
      <span className="checkout-header-secure"><LockKeyhole size={16} />Secure checkout</span>
    </div></header>
    <main className="checkout-main">
      <button type="button" className="checkout-model-back" onClick={() => {
        posthog.capture('order_back_to_model_clicked', { generation_id: generationId });
        navigate(getOrderReturnModelPath(state.generation_id, lastGenerationId));
      }}><ArrowLeft size={16} />Back to model</button>
      <div className="checkout-intro"><div><h1>Checkout</h1></div>
        <nav className="checkout-progress" aria-label="Checkout progress">{stepNames.map((title, index) =>
          <span key={title} className={index <= step ? 'is-current' : ''} aria-current={index === step ? 'step' : undefined}>
            <i>{index < step ? <Check size={12} /> : index + 1}</i>{title}
          </span>)}</nav>
      </div>
      {!generationId ? <section className="checkout-empty"><Package size={40} /><h2>Your kit starts with a model</h2><p>Choose or create a model to see your kit price and check out.</p><Link to="/" className="checkout-primary">Create a model<ArrowRight size={18} /></Link></section> :
      <div className="checkout-layout">
        <aside className="checkout-summary" aria-label="Order summary">
          <div className="checkout-summary-body">
            <p className="checkout-kit-eyebrow">YOUR CUSTOM KIT</p>
            <h2 className="checkout-summary-heading">{name}</h2>
            <div className="checkout-preview">{modelLoading ? <div role="status" className="checkout-preview-message"><span className="checkout-spinner" />Loading your model…</div> : mpdContent ? <ThreeLDRViewer modelContent={mpdContent} modelName={name} showModelControls={false} /> : state.screenshots?.angle1 ? <img src={state.screenshots.angle1} alt={name} /> : <div className="checkout-preview-message"><Package size={40} /><span>Your custom brick kit</span></div>}</div>
            <div className="checkout-summary-model">{partsCount ? <p>{partsCount.toLocaleString()} pieces</p> : null}<span className="checkout-quantity">Qty 1</span></div>
            {allParts && <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-slate-600">Using all parts mode is experimental. Some pieces may not fit. <Link className="underline underline-offset-2" to={`/instructions?id=${encodeURIComponent(generationId)}`}>Check the steps</Link> before you buy, or choose <Link className="underline underline-offset-2" to="/">Basic bricks</Link>.</p>}
            <button type="button" className="checkout-summary-toggle" aria-expanded={summaryExpanded} aria-controls="checkout-price-breakdown" onClick={() => {
              setSummaryExpanded(value => !value); posthog.capture('order_summary_toggled', { generation_id: generationId, expanded: !summaryExpanded });
            }}><span>Order summary<ChevronDown size={16} /></span><strong>{pricing ? formatOrderPrice(pricing.totalCents) : '—'}</strong></button>
            <div id="checkout-price-breakdown" className={`checkout-price-breakdown ${summaryExpanded ? 'is-expanded' : ''}`}>
            {pricing ? <>
              <dl className="checkout-price-list">
                <div><dt>Parts subtotal</dt><dd>{formatOrderPrice(pricing.fullPartSubtotalCents)}</dd></div>
                <div><dt>Standard shipping</dt><dd>{formatOrderPrice(pricing.fullShippingCents)}</dd></div>
                <div className="checkout-discount"><dt>BrickBuilder Launch Discount</dt><dd>−{formatOrderPrice(pricing.fullTotalCents - pricing.totalCents)}</dd></div>
                <div className="checkout-total"><dt>Total</dt><dd><s>{formatOrderPrice(pricing.fullTotalCents)}</s><span>USD</span>{formatOrderPrice(pricing.totalCents)}</dd></div>
              </dl>
              <p className="checkout-savings"><Check size={14} />You save {formatOrderPrice(pricing.fullTotalCents - pricing.totalCents)}</p>
            </> : <p className="checkout-section-note">{quoteLoading ? 'Calculating your kit price…' : 'Kit price unavailable'}</p>}
            </div>
            <div className="checkout-summary-benefits"><p><Truck size={16} />Estimated delivery: 8–12 business days</p></div>
          </div>
        </aside>
        <div className="checkout-flow" ref={stepFocusRef} tabIndex={-1}>
          {quoteError && <div className="checkout-error" role="alert">We couldn’t load your kit price.<button type="button" onClick={() => { posthog.capture('order_price_retry_clicked', { generation_id: generationId }); setQuoteAttempt(value => value + 1); }}>Try again</button></div>}
          <CheckoutStep title="Contact & delivery" number={1} active={step === 0} complete={step > 0} disabled={loading} onEdit={() => goToStep(0)}>
            <form onSubmit={startPayment}>
              <p className="checkout-section-note">Your kit is almost yours. Where should we send it?</p>
              <div className="checkout-field-grid">{field('email', 'Email address', 'email')}{field('name', 'Full name', 'shipping name')}{field('line1', 'Street address', 'shipping address-line1')}{showApartment ? field('line2', 'Apartment, suite, etc.', 'shipping address-line2', true) : <button type="button" className="checkout-add-apartment checkout-field-full" onClick={() => { setShowApartment(true); posthog.capture('order_apartment_field_opened', { generation_id: generationId }); }}>+ Add apartment, suite, etc.</button>}{field('city', 'City', 'shipping address-level2')}{field('region', country === 'US' ? 'State' : 'Province', 'shipping address-level1')}{field('postalCode', country === 'US' ? 'ZIP code' : 'Postal code', 'shipping postal-code')}
                <label className="checkout-field"><span>Country</span><select value={country} autoComplete="shipping country" disabled={loading} onChange={event => {
                  setCountry(event.target.value as 'US' | 'CA');
                  posthog.capture('order_shipping_country_changed', { generation_id: generationId, country: event.target.value });
                }}><option value="US">United States</option><option value="CA">Canada</option></select></label>
              </div>
              {error && <p className="checkout-error" role="alert">{error}</p>}
              <div className="checkout-actions"><button type="submit" className="checkout-primary" disabled={loading || !pricing || quoteLoading}>{loading ? 'Preparing payment…' : 'Continue to payment'}{loading ? <span className="checkout-spinner" /> : <ArrowRight size={19} />}</button></div>
            </form>
          </CheckoutStep>
          <CheckoutStep title="Payment" number={2} active={step === 1} complete={false} disabled={loading} onEdit={() => {}}>
            {session && pricing && <CheckoutPayment key={session.session_id} session={session} publishableKey={publishableKey} details={delivery} country={country} totalCents={pricing.totalCents} generationId={generationId} onBack={() => goToStep(0)} onRetry={() => { goToStep(0); void startPayment(); }} onBusyChange={setLoading} />}
          </CheckoutStep>
        </div>
      </div>}
    </main>
    <footer className="checkout-footer"><a href="mailto:support@brickbuilder.ai">Need help?</a><Link to="/privacy">Privacy Policy</Link><Link to="/terms">Terms of Service</Link></footer>
  </div>;
}
