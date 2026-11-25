import { useState } from 'react';
import posthog from 'posthog-js';
import { googleClick, landingClick, saveClick } from '../utils/googleClick';

export function GoogleAdMeasurement() {
  const [click, setClick] = useState(() => {
    const incoming = landingClick();
    if (!incoming || incoming === googleClick()) return null;
    saveClick(null);
    return incoming;
  });
  if (!click) return null;
  function decide(allow: boolean) {
    saveClick(allow ? click : null);
    window.dispatchEvent(new Event('google-ad-measurement-changed'));
    setClick(null);
    if (allow) posthog.capture('google_subscription_measurement_allowed');
  }
  return <aside aria-label="Google Ads measurement" className="fixed bottom-4 left-4 right-4 z-50 max-w-md rounded-xl border bg-white p-4 text-sm text-gray-900 shadow-lg">
    <p>Allow BrickBuilder to save this Google ad click for 90 days and share your subscription purchase details with Google to measure this ad?</p>
    <div className="mt-3 flex gap-4">
      <button className="font-semibold underline" onClick={() => decide(true)}>Allow</button>
      <button className="font-semibold underline" onClick={() => decide(false)}>Decline</button>
    </div>
  </aside>;
}
