import { supabase } from '../lib/supabase';

export const accountMfaEnabled = () => import.meta.env.VITE_MFA_ENABLED === 'true';

export async function verifyAuthenticator(factorId: string, code: string) {
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
  if (error) throw error;
}
