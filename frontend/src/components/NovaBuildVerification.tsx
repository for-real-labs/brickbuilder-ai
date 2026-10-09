import React from 'react';
import { CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';

export function NovaBuildVerification({ verified, busy, canVerify, onVerify, error }: {
  verified: boolean; busy: boolean; canVerify: boolean; onVerify: () => void; error?: string | null;
}) {
  return <section aria-label="Build verification" className="model-refine-card">
    <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
      {verified ? <CheckCircle2 size={18} className="shrink-0 text-emerald-600" /> : <ShieldCheck size={18} className="shrink-0 text-amber-600" />}
      <h2>{verified ? 'Build verified' : 'Unchecked preview'}</h2>
    </div>
    <p className="mt-2 text-sm leading-6 text-slate-600">
      {verified ? 'Connection and instruction checks passed. Any new edit creates a new unchecked preview.' :
        'Build and refine the full design first. When it looks right, Verify Build checks connections and building instructions.'}
    </p>
    <button type="button" disabled={busy || !canVerify} onClick={onVerify}
      title={!canVerify ? 'Only the owner can verify this build' : undefined}
      className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#f44336] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-50">
      {busy ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
      {busy ? 'Verifying…' : 'Verify Build'}
    </button>
    <p className="mt-2 text-xs leading-5 text-slate-500">Uses 1 additional credit. Full validation can take several minutes.</p>
    {error && <p role="alert" className="mt-2 break-words text-sm text-red-600">{error}</p>}
  </section>;
}
