// Keep the API's plain-text fallback usable by older clients while showing the
// exact reset in the browser's timezone across all generation services.
export async function localizeGenerationLimit(response: Response): Promise<Response> {
  if (response.status !== 429) return response;
  const retryAt = response.headers.get('Retry-After');
  if (!retryAt) return response;
  const resetAt = new Date(retryAt);
  if (!Number.isFinite(resetAt.getTime())) return response;
  const data = await response.clone().json().catch(() => null);
  const prefix = typeof data?.detail === 'string'
    ? data.detail.match(/^(?:You have reached the daily limit of ([1-9]|[12][0-9]|30) generations\.|AI builds are paused after 3 failed or canceled attempts within 24 hours\.)/)?.[0] : undefined;
  if (!prefix) return response;
  const localTime = new Intl.DateTimeFormat(undefined, {
    month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(resetAt);
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  return new Response(JSON.stringify({ ...data,
    detail: data.detail.replace(/Please wait until .*? to generate again\./, `Please wait until ${localTime} to generate again.`),
  }), { status: response.status, statusText: response.statusText, headers });
}
