import * as AppleAuthentication from 'expo-apple-authentication';

export const APPLE_SIGN_IN_EVENT = 'brickbuilder:apple-sign-in';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONCE = /^[0-9a-f]{64}$/;

type AppleSignInResult = {
  id: string;
  token?: string;
  code?: string;
  cancelled?: boolean;
  error?: boolean;
};

export class AppleSignIn {
  private pending = false;

  constructor(private origin: string, private emit: (result: AppleSignInResult) => void) {}

  async handle(raw: string, sourceUrl: string) {
    let message: { type?: unknown; id?: unknown; nonce?: unknown };
    try {
      if (raw.length > 512 || new URL(sourceUrl).origin !== this.origin) return;
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message?.type !== APPLE_SIGN_IN_EVENT || typeof message.id !== 'string' || !ID.test(message.id)
        || typeof message.nonce !== 'string' || !NONCE.test(message.nonce)) return;

    const { id, nonce } = message;
    if (this.pending) {
      this.emit({ id, error: true });
      return;
    }
    this.pending = true;
    try {
      if (!await AppleAuthentication.isAvailableAsync()) throw new Error('Apple sign-in is unavailable');
      const credential = await AppleAuthentication.signInAsync({
        nonce,
        state: id,
        requestedScopes: [AppleAuthentication.AppleAuthenticationScope.EMAIL],
      });
      if (credential.state !== id || !credential.identityToken || !credential.authorizationCode) throw new Error('Apple did not return a matching credential');
      this.emit({ id, token: credential.identityToken, code: credential.authorizationCode });
    } catch (error) {
      const cancelled = error instanceof Object && 'code' in error && error.code === 'ERR_REQUEST_CANCELED';
      this.emit(cancelled ? { id, cancelled: true } : { id, error: true });
    } finally {
      this.pending = false;
    }
  }
}

export function appleSignInDispatch(result: AppleSignInResult, origin: string): string {
  return `if (window.location.origin === ${JSON.stringify(origin)}) window.dispatchEvent(new CustomEvent(${JSON.stringify(APPLE_SIGN_IN_EVENT)}, { detail: ${JSON.stringify(result)} })); true;`;
}
