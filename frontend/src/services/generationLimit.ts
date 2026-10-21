// Keep the API's plain-text fallback usable by older clients while showing the
// exact reset in the browser's timezone across all generation services.
export async function localizeGenerationLimit(response: Response): Promise<Response> {
  if (response.status !== 429) return response;
  const retryAt = response.headers.get('Retry-After');
  if (!retryAt) return response;
  const resetAt = new Date(retryAt);
  if (!Number.isFinite(resetAt.getTime())) return response;
  const data = await response.clone().json().catch(() => null);
  if (typeof data?.detail !== 'string' || !data.detail.startsWith('You have reached the daily limit of 30 generations.')) return response;
  const localTime = new Intl.DateTimeFormat(undefined, {
    month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(resetAt);
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  return new Response(JSON.stringify({ ...data,
    detail: `You have reached the daily limit of 30 generations. Please wait until ${localTime} to generate again.`,
  }), { status: response.status, statusText: response.statusText, headers });
}
