const ACCOUNT_ROUTES = new Set([
  '/login', '/signup', '/reset-password', '/oauth/consent',
  '/dashboard', '/billing', '/account-deleted',
]);

export function isMaintenanceHost(hostname: string): boolean {
  return hostname === 'brickbuilder.ai' || hostname === 'www.brickbuilder.ai';
}

export function isMaintenanceAccountRoute(path: string): boolean {
  return ACCOUNT_ROUTES.has(path.toLowerCase().replace(/\/$/, ''));
}
