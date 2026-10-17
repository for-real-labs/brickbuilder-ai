// Keep sign-in destinations in the URL so an OAuth request survives reloads
// and opening the login page in another tab. Router state remains supported.
export function loginRedirect(search: string, fromState?: string): string {
  const candidate = new URLSearchParams(search).get('next') ?? fromState;
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//')
      || /[\\\u0000-\u0020\u007f]/.test(candidate)) return '/dashboard';
  return candidate;
}

export function isOAuthLogin(destination: string): boolean {
  const url = new URL(destination, 'https://brickbuilder.ai');
  return url.pathname === '/oauth/consent' && Boolean(url.searchParams.get('authorization_id'));
}
