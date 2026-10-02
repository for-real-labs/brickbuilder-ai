// OrderKit.tsx
import React from "react";
import { ArrowLeft, ArrowRight, BookOpen, Package } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { CreateCheckoutSessionApiService } from "../services/createCheckoutSessionApi";
import { PartListItem } from "../services/estimatePriceApi";
import { ThreeLDRViewer } from "../components/ThreeLDRViewer";
import { GetGenerationApiService } from "../services/getGenerationApi";
import { LdrToMpdApiService } from "../services/ldrToMpdApi";
import { SEO } from "../components/SEO";
import { SiteFooter } from "../components/SiteFooter";
import { supabase } from "../lib/supabase";
import posthog from "posthog-js";
import { getOrderReturnModelPath } from "../utils/generationRoutes";
import { GenerationTitle } from "../components/GenerationTitle";
import { useAuth } from "../contexts/AuthContext";
import { EmbeddedOrderCheckout } from "../components/EmbeddedOrderCheckout";
import { CreateCheckoutSessionResponse } from "../services/createCheckoutSessionApi";

type LocationState = {
  name?: string;
  parts_list?: PartListItem[];
  screenshots?: { angle1: string; angle2: string };
  generation_id?: string;
  cart_id?: string;
  priceData?: any; // EstimatePriceResponse type
};

type BomItem = {
  id: string;
  name: string;
  color: string;
  colorChip?: string;
  unitCents: number;
  qty: number;
  img?: string;
};

// --- Mock BOM using your provided assets ---
const MOCK_BOM: BomItem[] = [
  { id: "grey-2x4", name: "Brick 2x4", color: "Grey", colorChip: "#9ca3af", unitCents: 15, qty: 24, img: "/assets/Grey 2x4 Brick.png" },
  { id: "yellow-slope", name: "Curved Slope 2x2", color: "Yellow", colorChip: "#f59e0b", unitCents: 15, qty: 48, img: "/assets/Yellow Curved Slope.png" },
  { id: "grey-slope-1x1", name: "Curved Slope 1x1", color: "Light Grey", colorChip: "#cbd5e1", unitCents: 15, qty: 36, img: "/assets/Grey Curved Slope 1x1.png" },
  { id: "tan-1x2", name: "Brick 1x2", color: "Tan", colorChip: "#eab676", unitCents: 15, qty: 12, img: "/assets/Tan Brick 1x2.png" },
  { id: "turq-1x4", name: "Brick 1x4", color: "Turquoise", colorChip: "#14b8a6", unitCents: 12, qty: 30, img: "/assets/Turquoise Brick 1x4.png" },
  { id: "blue-stud-1x1", name: "Stud 1x1", color: "Blue", colorChip: "#3b82f6", unitCents: 10, qty: 90, img: "/assets/Blue Stud 1x1.png" },
  { id: "black-axle-pin", name: "Axle Pin", color: "Black", colorChip: "#111827", unitCents: 18, qty: 16, img: "/assets/Black Axle Pin.png" },
  { id: "brown-wheel", name: "Pirate Wheel", color: "Brown", colorChip: "#8b5e34", unitCents: 75, qty: 1, img: "/assets/Brown Pirate Wheel.png" },
];

function formatUSD(cents: number) {
  return (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" });
}

export default function OrderKit() {
  const location = useLocation() as { state: LocationState };
  const navigate = useNavigate();
  const { user } = useAuth();
  
  // Try to get state from navigation, otherwise restore from localStorage
  const getState = (): LocationState => {
    if (location.state) {
      // Save to localStorage for when user returns from Stripe
      localStorage.setItem('orderState', JSON.stringify(location.state));
      return location.state;
    }
    // Try to restore from localStorage (e.g., when returning from Stripe)
    const savedState = localStorage.getItem('orderState');
    if (savedState) {
      try {
        return JSON.parse(savedState);
      } catch {
        return {};
      }
    }
    return {};
  };
  
  const state = React.useMemo(getState, [location.state]);
  const lastGenerationId = localStorage.getItem('lastGenerationId');
  const generationId = state.generation_id || lastGenerationId || undefined;

  const [resolvedName, setResolvedName] = React.useState<string | null>(null);
  const name = resolvedName || state?.name || "Your Model";
  const [renameAccess, setRenameAccess] = React.useState<{
    generationId: string;
    userId: string;
    accessToken: string;
  } | null>(null);
  const canRename = !!renameAccess && renameAccess.generationId === generationId && renameAccess.userId === user?.id;

  React.useEffect(() => {
    let cancelled = false;
    setRenameAccess(null);
    if (!generationId || !user) return;
    const resolveRenameAccess = async () => {
      try {
        const [{ data, error }, { data: { session } }] = await Promise.all([
          supabase.from('generations').select('user_id').eq('id', generationId).maybeSingle(),
          supabase.auth.getSession(),
        ]);
        if (!cancelled && !error && data?.user_id === user.id && session?.access_token) {
          setRenameAccess({ generationId, userId: user.id, accessToken: session.access_token });
        }
      } catch {
        // Keep the title read-only when ownership cannot be verified.
      }
    };
    void resolveRenameAccess();
    return () => { cancelled = true; };
  }, [generationId, user?.id]);
  const size = "Regular"; // Default size since it's not passed in navigation state
  
  // Get model image from navigation state screenshots
  const getModelImage = () => {
    if (state?.screenshots?.angle1) {
      return state.screenshots.angle1; // Use View angle 01
    }
    return null; // Show nothing if no screenshot available
  };  const img = getModelImage();

  // Function to convert parts_list to BOM format
  const createBOMFromPartsList = React.useCallback((partsList: PartListItem[]): BomItem[] => {
    return partsList.map((part, index) => ({
      id: `part-${index}`,
      name: part.design_id,
      color: part.color_id,
      colorChip: "#9ca3af", // Default gray color
      unitCents: 0, // Placeholder $0 as requested
      qty: part.quantity,
      img: "/assets/Grey 2x4 Brick.png" // Placeholder image as requested
    }));
  }, []);

  // Get parts list from state or localStorage, fallback to mock data
  const getPartsList = React.useCallback((): BomItem[] => {
    // First try state from navigation
    if (state?.parts_list && Array.isArray(state.parts_list)) {
      return createBOMFromPartsList(state.parts_list);
    }
    
    // Then try localStorage
    try {
      const storedPartsList = localStorage.getItem('current_parts_list');
      if (storedPartsList) {
        const partsList = JSON.parse(storedPartsList);
        if (Array.isArray(partsList)) {
          return createBOMFromPartsList(partsList);
        }
      }
    } catch (error) {
      console.error('Failed to parse stored parts list:', error);
    }
    
    // Fallback to mock data
    return MOCK_BOM;
  }, [state?.parts_list, createBOMFromPartsList]);

  const BOM = getPartsList();
  
  // Use actual price data if available, otherwise return null (error state)
  const getActualPricing = (): { partSubtotalCents: number; shippingCents: number; totalCents: number; fullPartSubtotalCents: number; fullShippingCents: number; fullTotalCents: number } | null => {
    if (state?.priceData && state.priceData.total_weight !== undefined && state.priceData.total_weight !== null) {
      // Shipping formula: (weight * $18) + $4.00
      // conservative estimate found from https://www.webrick.com/shipping-fee
      const weightKg = state.priceData.total_weight;
      const fullShippingCents = Math.round((weightKg * 18 * 100) + 400);
      // total_price already includes shipping, so back it out to get the parts
      // subtotal. The launch discount applies to both parts and shipping.
      const fullPartsCents = Math.max(Math.round(state.priceData.total_price * 100) - fullShippingCents, 0);
      const partSubtotalCents = Math.round(fullPartsCents * 0.5);
      const shippingCents = Math.round(fullShippingCents * 0.5);
      return {
        partSubtotalCents,
        shippingCents,
        totalCents: partSubtotalCents + shippingCents,
        fullPartSubtotalCents: fullPartsCents,
        fullShippingCents,
        fullTotalCents: fullPartsCents + fullShippingCents
      };
    }
    
    // Return null when price/weight data is unavailable
    return null;
  };
  
  const pricing = getActualPricing();
  const pricingError = !pricing;
  const totalCents = pricing?.totalCents ?? 0;
  const fullPartSubtotalCents = pricing?.fullPartSubtotalCents ?? 0;
  const fullShippingCents = pricing?.fullShippingCents ?? 0;
  const fullTotalCents = pricing?.fullTotalCents ?? 0;

  const [loading, setLoading] = React.useState(false);
  const [checkoutSession, setCheckoutSession] = React.useState<CreateCheckoutSessionResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [mpdContent, setMpdContent] = React.useState<string | null>(null);
  const [modelLoading, setModelLoading] = React.useState(false);

  // Fetch model content for 3D preview
  React.useEffect(() => {
    const controller = new AbortController();
    setResolvedName(null);
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
        
        // Get MPD content from URL or convert LDR to MPD (same as GeneratedModel)
        let mpdContent: string | null = null;
        
        if (generationData.mpd_url) {
          try {
            const mpdResponse = await fetch(generationData.mpd_url);
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

  const handleCheckout = async () => {
  if (loading || checkoutSession) return;
  try {
    setLoading(true);
    setError(null);

    // Get generation_id and cart_id from state or localStorage
    const brickowlCartId = state?.cart_id || localStorage.getItem('current_cart_id') || undefined;

    posthog.capture('order_checkout_clicked', {
      generation_id: generationId,
      total_cents: totalCents,
      currency: 'USD',
      parts_quantity: BOM.reduce((total, part) => total + part.qty, 0),
      distinct_parts: BOM.length,
    });

    const data = await CreateCheckoutSessionApiService.createCheckoutSession({
      name: `${name} – ${size} Kit`,
      priceCents: totalCents,
      quantity: 1,
      generationId,
      brickowlCartId,
      uiMode: 'elements',
    });

    if (!data?.client_secret) throw new Error('Could not load the payment form. Please try again.');
    setCheckoutSession(data);
    posthog.capture('order_embedded_checkout_opened', { generation_id: generationId });
  } catch (e: any) {
    console.error(e);
    setError(e?.message || 'Could not start checkout. Please try again.');
  } finally {
    setLoading(false);
  }
};



  return (
    <div className="min-h-screen bg-[#f8fafc] text-slate-900">
      <SEO title={`Order Kit — ${name}`} description="Review and order your custom brick kit." url="https://brickbuilder.ai/order" />
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-5 sm:px-6 lg:px-10">
          <a href="/" className="flex items-center gap-2" onClick={() => posthog.capture('order_logo_clicked', { generation_id: generationId })}>
            <img src="/brickbuilder-logo.PNG" alt="" className="h-7 w-7 object-contain" />
            <span className="text-lg font-extrabold tracking-tight sm:text-xl"><span className="text-[#ff4b4b]">BRICK</span>BUILDER</span>
          </a>
          <span className="text-sm text-slate-500">Your cart</span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6 sm:px-6 lg:px-10">
        <button type="button" onClick={() => {
          posthog.capture('order_back_to_model_clicked', { generation_id: generationId });
          navigate(getOrderReturnModelPath(state.generation_id, lastGenerationId));
        }} className="mb-7 inline-flex items-center gap-2 text-sm font-medium text-slate-500 hover:text-slate-900">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to Model
        </button>

        <div className="mb-7 text-center">
          <p className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-[#e4443c]">Your custom brick kit</p>
          <GenerationTitle
            key={generationId || 'local'} name={name} generationId={generationId}
            canEdit={canRename && !modelLoading && !checkoutSession}
            accessToken={canRename ? renameAccess?.accessToken : undefined}
            onSaved={savedName => {
              setResolvedName(savedName);
              localStorage.setItem('lastModelName', savedName);
              localStorage.setItem('orderState', JSON.stringify({ ...state, name: savedName }));
            }}
          />
          <p className="mt-3 text-base leading-relaxed text-slate-500">Your custom brick kit, ready to build.</p>
        </div>

        <div className="grid w-full grid-cols-1 items-start gap-6 lg:grid-cols-[1.05fr_1fr] lg:gap-8">
          <section className="min-w-0 space-y-5" aria-label="Your kit and price">
            <div className="overflow-hidden rounded-2xl bg-white p-3 sm:p-4">
              <div className="relative w-full overflow-hidden rounded-2xl bg-slate-50" style={{ paddingTop: "66%" }}>
                <div className="absolute inset-0">
                  {modelLoading ? (
                    <div className="flex h-full items-center justify-center" role="status" aria-label="Loading model preview"><div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-[#f44336]" /></div>
                  ) : mpdContent ? (
                    <ThreeLDRViewer modelContent={mpdContent} modelName={name} showExplodeControl={false} />
                  ) : img ? (
                    <img src={img} alt={name} className="h-full w-full object-contain" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-sm text-slate-500">No preview available</div>
                  )}
                </div>
              </div>
            </div>

            <div aria-label="Pricing summary" className="rounded-2xl bg-white p-5 sm:p-6">
              <h2 className="mb-5 text-lg font-semibold">Pricing Summary</h2>
              <div className="space-y-4 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <span className="text-slate-600">Parts Subtotal</span>
                  <span className="shrink-0 font-medium">{pricingError ? '—' : formatUSD(fullPartSubtotalCents)}</span>
                </div>
                <div className="flex items-start justify-between gap-3">
                  <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-slate-600"><span>Shipping</span><span className="text-xs text-slate-500">(8-12 business days)</span></span>
                  <span className="shrink-0 font-medium">{pricingError ? '—' : formatUSD(fullShippingCents)}</span>
                </div>
                <div className="flex items-start justify-between gap-3 text-emerald-700">
                  <span>BrickBuilder Launch Discount -50%</span>
                  <span className="shrink-0 font-medium">{pricingError ? '—' : `-${formatUSD(fullTotalCents - totalCents)}`}</span>
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-4">
                  <span className="font-semibold">Total <span className="ml-1 text-xs font-normal text-slate-500">USD</span></span>
                  <span className="flex items-baseline gap-2">{!pricingError && <span className="text-sm text-slate-400 line-through">{formatUSD(fullTotalCents)}</span>}<span className="text-2xl font-bold tracking-tight">{pricingError ? '—' : formatUSD(totalCents)}</span></span>
                </div>
              </div>
            </div>
          </section>

          <aside className="min-w-0 border-t border-slate-200 pt-6 lg:sticky lg:top-6 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0" aria-label="Checkout">
            <h2 className="text-2xl font-semibold tracking-tight">{checkoutSession ? 'Shipping & payment' : 'Your order'}</h2>
            {!checkoutSession && <>
              <div className="mt-6 divide-y divide-slate-200">
                <div className="flex items-center gap-3 py-4"><Package className="h-5 w-5 shrink-0 text-slate-500" aria-hidden="true" /><span className="text-sm font-medium">Custom brick kit</span><span className="ml-auto text-sm text-slate-500">Qty 1</span></div>
                <div className="flex flex-wrap items-center gap-3 py-4"><BookOpen className="h-5 w-5 shrink-0 text-slate-500" aria-hidden="true" /><span className="text-sm font-medium">Building instructions</span><a href={generationId ? `/instructions?id=${encodeURIComponent(generationId)}` : '/instructions'} onClick={() => posthog.capture('order_instructions_clicked', { generation_id: generationId })} className="ml-auto inline-flex items-center gap-1 text-sm font-medium text-slate-600 underline underline-offset-4 hover:text-slate-900">View instructions <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></a></div>
              </div>
              <div className="mt-6 flex items-baseline justify-between gap-3 border-t border-slate-200 pt-6"><span className="text-lg font-medium">Total</span><span className="text-2xl font-semibold tracking-tight">{pricingError ? '—' : formatUSD(totalCents)} <span className="text-xs font-normal text-slate-500">USD</span></span></div>
              {pricingError && <p role="alert" className="mt-4 text-sm leading-5 text-amber-900">We couldn't load your price. Go back to your model and estimate the price again to continue.</p>}
              <button type="button" disabled={loading || pricingError} onClick={handleCheckout} className="mt-6 flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-[#ef493f] px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#d83930] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#ef493f] disabled:cursor-not-allowed disabled:bg-slate-300">
                {loading ? 'Loading checkout…' : pricingError ? 'Price unavailable' : 'Continue to checkout'}
                {!loading && !pricingError && <ArrowRight className="h-4 w-4" aria-hidden="true" />}
              </button>
            </>}
            {error && <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
            {checkoutSession?.client_secret && <EmbeddedOrderCheckout clientSecret={checkoutSession.client_secret} generationId={generationId} onComplete={() => {
              posthog.capture('order_embedded_checkout_completed', { generation_id: generationId });
              navigate(`/success?session_id=${encodeURIComponent(checkoutSession.session_id)}`);
            }} />}
            <p className="mt-5 text-center text-xs text-slate-500"><a href="mailto:support@brickbuilder.ai" onClick={() => posthog.capture('order_support_clicked', { generation_id: generationId })} className="underline underline-offset-4 hover:text-slate-900">Need help? Contact us</a></p>
          </aside>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
