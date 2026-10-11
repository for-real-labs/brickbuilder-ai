const generationEndpoints = /^\/(textToBricks|imageToBricks|llmToBricks|novaToBricks)(\/stream)?$|^\/(glbToBricks|uploadLdraw)$/;

/** Add the submitting pathname only to generation requests, never URL queries. */
export function withGenerationEntryPage(url: string, init: RequestInit): RequestInit {
  if (typeof window === 'undefined' || init.method?.toUpperCase() !== 'POST'
    || !generationEndpoints.test(new URL(url, window.location.origin).pathname)) return init;
  const entryPage = window.location.pathname;
  if (init.body instanceof FormData) {
    const body = new FormData();
    init.body.forEach((value, key) => body.append(key, value));
    body.set('entry_page', entryPage);
    return { ...init, body };
  }
  if (typeof init.body === 'string') {
    const body = JSON.parse(init.body);
    return { ...init, body: JSON.stringify({ ...body, entry_page: entryPage }) };
  }
  return init;
}
