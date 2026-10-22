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
  ['What uses a credit?', 'Each new AI build or AI edit uses one credit, in either generation mode. Uploading LDraw, manually editing, resizing, viewing instructions, and downloading existing models use no credits. Physical brick kits are purchased separately.'],
  ['When do credits reset?', 'Paid credits reset on your monthly billing date. Free credits reset on the first day of each month at 00:00 UTC. Unused monthly credits do not roll over. Your balance shows the reset date in your timezone.'],
  ['What happens to my existing credits?', 'Your balance from before subscriptions launched is kept as bonus credits. They never expire and are used after your monthly credits.'],
  ['Can I cancel?', 'Yes. Open My billing → Cancel subscription to confirm cancellation in Stripe. You keep the remaining credits from your paid plan until the end of that billing period. Then your account returns to Free. Your saved models and bonus credits stay available.'],
  ['Can I buy credits without subscribing?', 'We currently offer monthly plans only. If you need more credits, you can change your plan. Stripe shows any prorated charge before you confirm. Upgrades add the difference in credits; downgrades take effect at renewal.'],
  ['What if a build fails?', 'Failed and canceled builds return their credit automatically. A returned monthly credit belongs to its original billing period. The existing daily limit of 30 generation attempts still applies to every plan.'],
];

export default function PricingPage() {
  const { error } = useBilling();
  useEffect(() => { posthog.capture('billing_pricing_viewed', { source: 'pricing_page' }); }, []);
  return <div className="billing-page"><Helmet><title>Plans & credits | BrickBuilder</title><meta name="description" content="Build with AI from $5 per month. Choose 30, 100, or 300 monthly credits. Cancel anytime. Every plan includes your Build Buddy." /></Helmet>
    <BillingHeader />
    <main className="billing-main"><div className="billing-hero"><div className="billing-hero-pets"><PetAvatar id="pip" /><PetAvatar id="nib" /><PetAvatar id="clik" /></div>
      <p className="billing-eyebrow">YOUR IDEAS. YOUR BUDDY. YOUR NEXT BUILD.</p><h1>Keep your ideas building.</h1>
      <p>A little project or a whole brick universe. Find your room to create.</p><span className="billing-monthly-pill">Monthly plans · Cancel anytime</span></div>
      {error && <p className="billing-error" role="alert">{error}</p>}
      <PlanGrid source="pricing_page" />
      <p className="billing-fine-print">One credit = one AI build or AI edit. Paid plans renew monthly until canceled. Monthly credits reset without rollover. Physical brick kits are sold separately.</p>
      <section className="billing-faq" aria-labelledby="billing-faq-title"><p className="billing-eyebrow">THE SMALL PRINT, MADE SIMPLE</p><h2 id="billing-faq-title">A few good questions.</h2>
        {faqs.map(([question, answer]) => <details key={question} onToggle={e => { if (e.currentTarget.open) posthog.capture('billing_faq_opened', { question }); }}><summary>{question}</summary><p>{answer}</p></details>)}
      </section>
    </main><footer className="billing-footer"><span>Made for your imagination.</span><Link to="/terms" onClick={() => posthog.capture('billing_terms_clicked')}>Terms</Link><Link to="/privacy" onClick={() => posthog.capture('billing_privacy_clicked')}>Privacy</Link></footer>
  </div>;
}
