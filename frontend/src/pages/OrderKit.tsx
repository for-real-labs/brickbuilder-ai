// OrderKit.tsx
import React from "react";
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
  
  const state = getState();
  const lastGenerationId = localStorage.getItem('lastGenerationId');
  const generationId = state.generation_id || lastGenerationId || undefined;

  const [resolvedName, setResolvedName] = React.useState<string | null>(null);
  const name = resolvedName || state?.name || "Your Model";
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
      // subtotal. Summer sale: 50% off everything (parts + shipping, 6/22-7/22).
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
  const partSubtotalCents = pricing?.partSubtotalCents ?? 0;
  const shippingCents = pricing?.shippingCents ?? 0;
  const totalCents = pricing?.totalCents ?? 0;
  const fullPartSubtotalCents = pricing?.fullPartSubtotalCents ?? 0;
  const fullShippingCents = pricing?.fullShippingCents ?? 0;
  const fullTotalCents = pricing?.fullTotalCents ?? 0;

  const [loading, setLoading] = React.useState(false);
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
    });

    console.log('Checkout session payload:', data);

    if (!data?.checkout_url) throw new Error('No checkout URL returned');
    const url = data.checkout_url.includes('?') ? `${data.checkout_url}&locale=en` : `${data.checkout_url}?locale=en`;
    window.location.href = data.checkout_url; // ✅ redirect to hosted checkout
  } catch (e: any) {
    console.error(e);
    setError(e?.message || 'Could not start checkout. Please try again.');
  } finally {
    setLoading(false);
  }
};



  return (
    <div className="min-h-screen bg-white">
      <SEO title={`Order Kit — ${name}`} description="Review and order your custom brick kit." url="https://brickbuilder.ai/order" />
      {/* Top nav with logo */}
      <header className="w-full border-b border-slate-200 landing-fade-in landing-delay-1">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 sm:px-6 md:px-8 lg:px-10 py-4">
          <a href="/" className="flex items-center gap-3">
            <img
              src="/logo.svg"
              alt="BrickBuilder"
              className="h-7 w-auto"
              onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
            />
            <span className="text-xl font-extrabold tracking-tight">
              <span className="text-[#ff4b4b]">BRICK</span>
              <span className="text-slate-900">BUILDER</span>
            </span>
          </a>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 sm:px-6 md:px-8 lg:px-10 pb-16 pt-6">
        {/* Back to model link under logo */}
        <button
          type="button"
          onClick={() => navigate(getOrderReturnModelPath(state.generation_id, lastGenerationId))}
          className="mt-2 mb-4 inline-flex items-center gap-2 text-sm text-slate-700 hover:underline landing-fade-in landing-delay-2"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Back to Model
        </button>

        <h1 className="mb-6 break-words text-2xl font-semibold tracking-tight sm:text-3xl">{name}</h1>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 landing-fade-in landing-delay-3">
          {/* LEFT: model hero + BOM list */}
          <section className="lg:col-span-2">
            {/* 3D Model Preview */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm mb-6">
              <div
                className="relative w-full overflow-hidden rounded-xl bg-slate-50"
                style={{ paddingTop: "66%" }}
              >
                <div className="absolute inset-0">
                  {modelLoading ? (
                    <div className="w-full h-full flex items-center justify-center">
                      <div className="w-8 h-8 border-4 border-slate-200 border-t-[#f44336] rounded-full animate-spin"></div>
                    </div>
                  ) : mpdContent ? (
                    <ThreeLDRViewer
                      modelContent={mpdContent}
                      modelName={name}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-slate-400">
                      No preview available
                    </div>
                  )}
                </div>
              </div>
              <p className="text-center text-slate-500 mt-3">3D Preview - {size} size kit</p>
            </div>

            {/* Shipping Info Card */}
            <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-6">
              <div className="flex items-center gap-3">
                {/* shipping icon */}
                <div className="h-12 w-12 rounded-full bg-[#f44336]/10 flex items-center justify-center shrink-0">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-[#f44336]" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M20 8h-3V4H3v13h2a3 3 0 0 0 6 0h4a3 3 0 0 0 6 0h2v-5l-3-4Zm-3 7a1 1 0 1 1 2 0 1 1 0 0 1-2 0ZM7 19a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm11-7h-4V6h2v2h2l2 3v1Z" />
                  </svg>
                </div>
                <div>
                  <div className="font-semibold text-slate-900">Estimated Shipping</div>
                  <div className="text-sm text-slate-600">8 business days</div>
                </div>
              </div>
            </div>

            {/* BOM card - COMMENTED OUT FOR NOW */}
            {/* <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
                <div className="font-semibold">Bill of Materials</div>
                <div className="flex items-center gap-2 text-slate-500 text-sm">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M20 8h-3V4H3v13h2a3 3 0 0 0 6 0h4a3 3 0 0 0 6 0h2v-5l-3-4Zm-3 7a1 1 0 1 1 2 0 1 1 0 0 1-2 0ZM7 19a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm11-7h-4V6h2v2h2l2 3v1Z" />
                  </svg>
                  <span>Est. ship: 12-18 business days</span>
                </div>
              </div>

              <div className="px-6 py-3 text-xs font-semibold text-slate-500">
                <div
                  className="grid items-center"
                  style={{ gridTemplateColumns: "70% 20% 10%" }}
                >
                  <div>Part</div>
                  <div>Color</div>
                  <div className="text-right">Qty</div>
                </div>
              </div>

              <div>
                {BOM.map((it) => {
                  return (
                    <div key={it.id} className="px-6 py-4 border-t border-slate-100">
                      <div
                        className="grid items-center gap-2"
                        style={{ gridTemplateColumns: "70% 20% 10%" }}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="h-10 w-10 rounded-md border border-slate-200 bg-white overflow-hidden flex items-center justify-center shrink-0">
                            {it.img ? (
                              <img src={it.img} alt={it.name} className="h-full w-full object-contain" />
                            ) : (
                              <div className="h-6 w-8 rounded-sm" style={{ background: it.colorChip || "#e5e7eb" }} />
                            )}
                          </div>
                          <div className="text-sm font-medium truncate">{it.name}</div>
                        </div>

                        <div className="flex items-center gap-2">
                          <span
                            className="h-3 w-3 rounded-full border border-slate-300 shrink-0"
                            style={{ background: it.colorChip || "#e5e7eb" }}
                            aria-hidden
                          />
                          <span className="text-sm whitespace-nowrap">{it.color}</span>
                        </div>

                        <div className="text-sm text-right whitespace-nowrap">{it.qty}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            */}
          </section>

          {/* RIGHT: sticky pricing summary + checkout */}
          <aside className="lg:col-span-1 self-start">
            <div className="sticky top-24">
              <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-6">
                <h3 className="text-lg font-semibold mb-4">Pricing Summary</h3>
                <div className="space-y-2 text-sm">
                    <div className="flex items-center justify-between">
                        <span>Parts Subtotal</span>
                        <span className="flex items-baseline gap-2">
                          <span className="text-slate-400 line-through">{formatUSD(fullPartSubtotalCents)}</span>
                          <span>{formatUSD(partSubtotalCents)}</span>
                        </span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span>Shipping</span>
                        <span className={pricingError ? "text-red-500 font-medium" : "flex items-baseline gap-2"}>
                          {pricingError ? "Error calculating shipping" : (
                            <>
                              <span className="text-slate-400 line-through">{formatUSD(fullShippingCents)}</span>
                              <span>{formatUSD(shippingCents)}</span>
                            </>
                          )}
                        </span>
                    </div>
                    <div className="h-px bg-slate-200 my-2" />
                    <div className="flex items-center justify-between text-base font-bold">
                        <span>Total</span>
                        <span className="flex items-baseline gap-2">
                          <span className="text-slate-400 line-through font-normal">{formatUSD(fullTotalCents)}</span>
                          <span>{formatUSD(totalCents)}</span>
                        </span>
                    </div>
                </div>
                {/* Checkout button */}
                <button
                  type="button"
                  disabled={loading || pricingError}
                  onClick={handleCheckout}
                  className={`mt-6 w-full h-12 rounded-full text-white font-semibold shadow-md transition-all disabled:opacity-50 ${
                    pricingError ? 'bg-gray-400 cursor-not-allowed' : 'bg-[#f44336] hover:bg-[#ff6b6b] hover:scale-[1.02]'
                  }`}
                >
                  {loading ? "Redirecting…" : pricingError ? "Cannot Checkout" : "Checkout"}
                </button>

                {/* Download instructions - COMMENTED OUT FOR NOW */}
                {/* <div className="mt-6 flex items-center gap-3">
                  <div className="h-8 w-8 rounded-full bg-[#ff4b4b]/15 flex items-center justify-center">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-black" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 3a1 1 0 0 1 1 1v8l2.293-2.293a1 1 0 1 1 1.414 1.414l-4 4a1 1 0 0 1-1.414 0l-4-4a1 1 0 1 1 1.414-1.414L11 12V4a1 1 0 0 1 1-1ZM5 20a1 1 0 0 1 0-2h14a1 1 0 1 1 0 2H5Z" />
                    </svg>
                  </div>
                  <button
                    className="text-sm font-medium text-slate-800 hover:underline"
                    onClick={() => alert("Download available after purchase")}
                  >
                    Download Instructions
                  </button>
                </div> */}

                {error && <p className="text-red-500 mt-4 text-sm">{error}</p>}
              </div>
            </div>
          </aside>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
