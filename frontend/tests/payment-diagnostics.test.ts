import { expect, it } from 'vitest';
import { paymentDiagnostics } from '../src/utils/paymentDiagnostics';

it('keeps the failure reason but strips secrets, contact data, numbers and nested payment objects', () => {
  const diagnostic = paymentDiagnostics({
    type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds', status: 402,
    message: 'Declined for Jane Doe jane@example.com at 123 Main Street: 4242 4242 4242 4242 CVC 123 cs_live_abc_secret_xyz https://stripe.test/?secret=abc',
    payment_method: { card: { number: '4242424242424242' } },
  }, ['Jane Doe', '123 Main Street']);
  expect(diagnostic).toMatchObject({ error_type: 'card_error', error_code: 'card_declined', decline_code: 'insufficient_funds', http_status: 402 });
  const text = JSON.stringify(diagnostic);
  for (const value of ['Jane', 'jane@', 'Main', '4242', '123', 'secret', 'payment_method']) expect(text).not.toContain(value);
  expect(diagnostic.error_message).toContain('Declined');
});

it('records thrown Error messages, string exceptions and absent errors without serializing arbitrary objects', () => {
  expect(paymentDiagnostics(new TypeError('Failed to fetch'))).toMatchObject({ error_type: 'TypeError', error_message: 'Failed to fetch' });
  expect(paymentDiagnostics('Offline').error_message).toBe('Offline');
  expect(paymentDiagnostics({ private: 'hidden' }).error_message).toBe('Unknown payment error');
  expect(paymentDiagnostics(new Error('x'.repeat(1000))).error_message).toHaveLength(400);
});
