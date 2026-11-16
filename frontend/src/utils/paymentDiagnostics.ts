/** Never serialize Stripe error objects: they may contain payment/customer data. */
export function paymentDiagnostics(error: unknown, privateValues: string[] = []) {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const raw = typeof value.message === 'string' ? value.message : typeof error === 'string' ? error : 'Unknown payment error';
  let message = raw;
  for (const secret of privateValues.filter(value => value.trim()).sort((a, b) => b.length - a.length)) {
    message = message.replace(new RegExp('(?<![a-zA-Z0-9])' + secret.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-zA-Z0-9])', 'gi'), '[redacted]');
  }
  message = message
    .replace(/\b(?:cs|pi|seti|sk|pk)_[A-Za-z0-9_]+\b/g, '[redacted]')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b\d[\d\s-]{2,}\d\b/g, '[number]')
    .replace(/\b\d{3}\b/g, '[number]')
    .replace(/[\r\n\t]+/g, ' ').slice(0, 400);
  const token = (key: string) => typeof value[key] === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(value[key] as string) ? value[key] as string : undefined;
  return {
    error_message: message,
    error_type: token('type') || token('name') || 'unknown',
    error_code: token('code'),
    decline_code: token('decline_code'),
    http_status: typeof value.status === 'number' ? value.status : undefined,
  };
}
