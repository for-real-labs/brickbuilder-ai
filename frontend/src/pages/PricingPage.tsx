import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight } from 'lucide-react';
import { Helmet } from 'react-helmet-async';
import posthog from 'posthog-js';
import { useBilling } from '../contexts/BillingContext';
import { PlanGrid } from '../components/BillingComponents';
import { PetAvatar } from '../components/PetCompanion';

export function BillingHeader() {
  const track = (destination: string) => posthog.capture('billing_navigation_clicked', { destination, page: window.location.pathname });
  return <header className="billing-header"><Link to="/" onClick={() => track('/')} className="billing-brand"><span><b>BRICK</b>BUILDER</span></Link>
    <nav aria-label="Billing navigation"><Link to="/" aria-label="Back to building" onClick={() => track('/')}><ArrowLeft size={15} /> <span>Back to building</span></Link>
      <Link to="/billing" onClick={() => track('/billing')}>My billing <ArrowUpRight size={15} /></Link></nav></header>;
}

const faqs = [
  ['What uses a credit?', 'Basic builds and Basic AI edits use 1 credit. All parts builds, All parts edits, and AI image/text-to-mesh conversions use 15 credits on every plan, including Free. You can mix modes from your monthly balance. Whole-build examples round down; leftover credits remain usable for Basic builds. Importing LDraw/GLB/OBJ, manual edits, and resizing use no credits. LDR/IO exports and building instructions require Builder or Creator and use no extra credits. Physical brick kits are purchased separately.'],
  ['Can I download models or view instructions on Free?', 'Free includes model creation and 3D previews. LDR/IO exports and building instructions are locked on Free. Choose Builder or Creator to unlock them. CSV and XML parts lists remain available on Free.'],
  ['Can I try it first?', 'Yes. Without logging in, you get 75 lifetime credits: 5 All parts builds or 75 Basic builds, or a mix. Basic uses 1 credit and All parts uses 15. The guest allowance does not reset; failed or canceled builds return their credits. Sign in for 300 free credits each calendar month. Guest builds claimed in that month count toward your Free allowance. No payment card is needed.'],
  ['When do credits reset?', 'Paid credits reset on your monthly billing date. Free credits reset on the first day of each month at 00:00 UTC. Unused monthly credits do not roll over. Your balance shows the reset date in your timezone.'],
  ['What if builds keep failing or I keep canceling?', 'Failed or canceled builds return credits, but AI work may already have a cost. After 5 failed or canceled AI builds within 24 hours, new builds using BrickBuilder credits pause until fewer than 5 remain in that window. We show when you can retry. Running builds reserve retry slots too. This applies to every plan and guest browser/network; upgrading does not remove the pause. Your own API-key usage is exempt.'],
  ['What happens to my existing credits?', 'Your existing balance is preserved as legacy bonus credits and never expires. After your monthly credits, redeem up to 5 bonus credits per calendar month for Basic builds. Bonuses cannot be used for All parts or AI mesh conversions. Unused bonuses stay in your account.'],
  ['Can I cancel?', 'Yes. Open My billing → Cancel subscription to confirm cancellation in Stripe. You keep the remaining credits from your paid plan until the end of that billing period. Then your account returns to Free. Your saved models and bonus credits stay available.'],
  ['Can I buy credits without subscribing?', 'We currently offer monthly plans only. If you need more credits, you can change your plan. Stripe shows any prorated charge before you confirm. Upgrades add the difference in credits; downgrades take effect at renewal.'],
  ['What if a build fails?', 'Failed and canceled builds return their credits automatically to the original credit period. Monthly credits cover your builds, with one build running at a time. Account restrictions may also apply. Capacity limits can temporarily pause new builds; your saved models and subscription cancellation remain available.'],
];

export default function PricingPage() {
  const { error, enabled, account, checkoutAvailable } = useBilling();
  useEffect(() => { posthog.capture('billing_pricing_viewed', { source: 'pricing_page' }); }, []);
  return <div className="billing-page"><Helmet><title>Plans & credits | BrickBuilder</title><meta name="description" content="Start with 300 free monthly credits. Builder includes 500 credits for $9/month; Creator includes 750 for $19/month. Paid plans unlock LDR/IO exports and instructions. Cancel anytime." /></Helmet>
    <BillingHeader />
    <main className="billing-main"><div className="billing-hero"><div className="billing-hero-pets"><PetAvatar id="pip" /><PetAvatar id="nib" /><PetAvatar id="clik" /></div>
      <p className="billing-eyebrow">YOUR IDEAS. YOUR BUDDY. YOUR NEXT BUILD.</p><h1>Keep your ideas building.</h1>
      <p>A little project or a whole brick universe. Find your room to create.</p><span className="billing-monthly-pill">Monthly plans · Cancel anytime</span></div>
      {error && (enabled || account) && <p className="billing-error" role="alert">{error}</p>}
      {!enabled && <p className="billing-launch-notice" role="status">Monthly plans are coming soon. You can keep building with your current access.</p>}
      {enabled && !checkoutAvailable && <p className="billing-launch-notice" role="status">New subscriptions are temporarily at capacity. Please check back soon. Existing subscribers can still manage or cancel in My billing.</p>}
      <PlanGrid source="pricing_page" />
      <p className="billing-fine-print">Basic builds: 1 credit. All parts and AI mesh conversions: 15 credits on every plan. Paid plans renew monthly until canceled. Monthly credits reset without rollover. Physical brick kits are sold separately.</p>
      <section className="billing-faq" aria-labelledby="billing-faq-title"><p className="billing-eyebrow">THE SMALL PRINT, MADE SIMPLE</p><h2 id="billing-faq-title">A few good questions.</h2>
        {faqs.map(([question, answer]) => <details key={question} onToggle={e => { if (e.currentTarget.open) posthog.capture('billing_faq_opened', { question }); }}><summary>{question}</summary><p>{answer}</p></details>)}
      </section>
    </main><footer className="billing-footer"><span>Made for your imagination.</span><Link to="/terms" onClick={() => posthog.capture('billing_terms_clicked')}>Terms</Link><Link to="/privacy" onClick={() => posthog.capture('billing_privacy_clicked')}>Privacy</Link></footer>
  </div>;
}
