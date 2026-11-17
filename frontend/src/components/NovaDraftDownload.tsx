import React from 'react';
import posthog from 'posthog-js';
import { NovaToBricksApiService } from '../services/novaToBricksApi';

export function NovaDraftDownload({ generationId }: { generationId: string }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  async function download() {
    setBusy(true);
    setError('');
    try {
      const archive = await NovaToBricksApiService.downloadSource(generationId);
      const url = URL.createObjectURL(archive);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'unverified-model-draft.zip';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      posthog.capture('nova_draft_downloaded', { generation_id: generationId });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to download the draft.');
      posthog.capture('nova_draft_download_failed', { generation_id: generationId });
    } finally {
      setBusy(false);
    }
  }
  return <div className="mt-3 min-w-0">
    <p className="text-xs text-slate-600">Unverified draft with model, parts list and failed checks. Repair is required before instructions or ordering.</p>
    <button type="button" disabled={busy} onClick={download}
      className="mt-2 min-h-11 w-full rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
      {busy ? 'Downloading…' : 'Download draft and failed checks'}
    </button>
    {error && <p role="alert" className="mt-2 break-words text-xs text-red-600">{error}</p>}
  </div>;
}
