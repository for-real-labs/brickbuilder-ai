import { useState } from 'react';
import posthog from 'posthog-js';
import { META_MEASUREMENT_CHANGED, metaClick, metaLandingClick, saveMetaClick } from '../utils/metaClick';

export function MetaAdMeasurement() {
  const [click, setClick] = useState(() => {
    const incoming = metaLandingClick(window.location.search);
    if (!incoming || incoming.id === metaClick()?.id) return;
    saveMetaClick();
    return incoming;
  });
  if (!click) return null;

  function decide(allow: boolean) {
    saveMetaClick(allow ? click : undefined);
    window.dispatchEvent(new Event(META_MEASUREMENT_CHANGED));
    setClick(undefined);
    if (allow) posthog.capture('meta_subscription_measurement_allowed');
  }

  return <aside aria-label="Meta ad measurement" className="fixed bottom-4 left-4 right-4 z-50 max-w-md rounded-xl border bg-white p-4 text-sm text-gray-900 shadow-lg">
    <p>Allow BrickBuilder to save this ad click in this tab for up to 7 days and share the click ID, browser type, and first subscription payment amount with Meta to measure this ad?</p>
    <div className="mt-3 flex flex-wrap gap-4">
      <button className="min-h-10 font-semibold underline" onClick={() => decide(true)}>Allow</button>
      <button className="min-h-10 font-semibold underline" onClick={() => decide(false)}>Decline</button>
    </div>
  </aside>;
}
