import { useEffect, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { isMaintenanceAccountRoute, isMaintenanceHost } from '../maintenanceRoutes';

export function MaintenanceNavigation({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const gated = import.meta.env.VITE_MAINTENANCE_ACTIVE === 'true'
    && typeof window !== 'undefined' && isMaintenanceHost(window.location.hostname)
    && !isMaintenanceAccountRoute(pathname);
  useEffect(() => {
    if (gated) window.location.reload();
  }, [gated]);
  return gated ? null : children;
}
