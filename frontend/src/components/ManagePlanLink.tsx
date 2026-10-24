import React from 'react';
import { CreditCard } from 'lucide-react';
import { Link } from 'react-router-dom';
import posthog from 'posthog-js';

export function ManagePlanLink({ source, onClick }: { source: string; onClick?: () => void }) {
  return <Link to="/billing" onClick={() => {
    posthog.capture('billing_navigation_clicked', { source, destination: '/billing' });
    onClick?.();
  }} className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 hover:border-red-300 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2">
    <CreditCard aria-hidden="true" className="h-4 w-4" />Manage Plan
  </Link>;
}
