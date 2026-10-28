import { createClient, SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// Supabase is optional. It is only enabled when both the URL and anon key are
// present. When disabled, the app runs in anonymous mode and authentication
// features are unavailable.
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

// A minimal no-op client used when Supabase is not configured. It implements
// just enough of the SupabaseClient surface used by the app so that call sites
// keep working without throwing.
function createStubClient(): SupabaseClient {
  const notConfiguredError = {
    name: 'SupabaseNotConfigured',
    message: 'Supabase is not configured',
  }

  const queryBuilder: any = {
    select: () => queryBuilder,
    eq: () => queryBuilder,
    update: () => queryBuilder,
    single: async () => ({ data: null, error: notConfiguredError }),
    then: (resolve: (value: { data: null; error: typeof notConfiguredError }) => unknown) =>
      resolve({ data: null, error: notConfiguredError }),
  }

  const stub = {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({
        data: { subscription: { unsubscribe: () => {} } },
      }),
      signInWithPassword: async () => ({ data: { user: null, session: null }, error: notConfiguredError }),
      signUp: async () => ({ data: { user: null, session: null }, error: notConfiguredError }),
      resend: async () => ({ data: {}, error: notConfiguredError }),
      resetPasswordForEmail: async () => ({ data: {}, error: notConfiguredError }),
      updateUser: async () => ({ data: { user: null }, error: notConfiguredError }),
      signOut: async () => ({ error: null }),
      signInWithOtp: async () => ({ data: {}, error: notConfiguredError }),
      verifyOtp: async () => ({ data: { user: null, session: null }, error: notConfiguredError }),
      signInWithOAuth: async () => ({ data: {}, error: notConfiguredError }),
    },
    from: () => queryBuilder,
    rpc: async () => ({ data: null, error: notConfiguredError }),
  }

  return stub as unknown as SupabaseClient
}

export const supabase: SupabaseClient = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        detectSessionInUrl: true,
        // Auto-refresh tokens before they expire
        autoRefreshToken: true,
        // Session will persist for 30 days
        // Recovery email may open Safari instead of the requesting iOS WebView.
        // Its one-time link establishes its own session without a device-bound verifier.
        flowType: typeof window !== 'undefined' && window.location.pathname === '/reset-password' ? 'implicit' : 'pkce',
      },
      // Additional client options for session persistence
      global: {
        headers: {
          'X-Client-Info': 'lego-react-app',
        },
      },
    })
  : createStubClient()


// Only sends recovery mail; never persists a second session or parses callbacks.
// Other sign-in flows keep PKCE. Supabase validates and consumes the recovery link.
let recoveryClient: SupabaseClient | undefined;
export function passwordRecoveryClient(): SupabaseClient {
  if (!isSupabaseConfigured) return supabase;
  return recoveryClient ??= createClient(supabaseUrl, supabaseAnonKey, {
    auth: { flowType: 'implicit', persistSession: false, autoRefreshToken: false,
      detectSessionInUrl: false, storageKey: 'brickbuilder-password-recovery' },
  });
}
