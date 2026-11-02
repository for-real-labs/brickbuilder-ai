import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight } from 'lucide-react';
import posthog from 'posthog-js';
import { useBilling } from '../contexts/BillingContext';

export function BillingHeader() {
  const { openUpgrade } = useBilling();
  const track = (destination: string) => posthog.capture('billing_navigation_clicked', { destination, page: window.location.pathname });
  return <header className="billing-header"><Link to="/" onClick={() => track('/')} className="billing-brand"><span><b>BRICK</b>BUILDER</span></Link>
    <nav aria-label="Billing navigation"><Link to="/" aria-label="Back to building" onClick={() => track('/')}><ArrowLeft size={15} /> <span>Back to building</span></Link>
      <button type="button" onClick={() => { track('plans_popup'); openUpgrade('pricing_button'); }}>Pricing <ArrowUpRight size={15} /></button></nav></header>;
}
