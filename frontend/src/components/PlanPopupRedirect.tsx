import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBilling } from '../contexts/BillingContext';

/** Keep saved pricing links working through the shared popup on the landing page. */
export function PlanPopupRedirect() {
  const { openUpgrade } = useBilling();
  const navigate = useNavigate();
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    openUpgrade('pricing_link');
    navigate('/', { replace: true });
  }, [navigate, openUpgrade]);
  return null;
}
