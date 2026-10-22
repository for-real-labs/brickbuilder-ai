import React, { createContext, useContext, useEffect, useState } from 'react'
import { User, Session, AuthError } from '@supabase/supabase-js'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { UpdateUsernameApiService, UsernameTakenError } from '../services/updateUsernameApi'
import { ClaimGenerationApiService } from '../services/claimGenerationApi'
import { getAnonymousGenerationIds, removeAnonymousGenerationId } from '../utils/anonGenerations'
import { previewLoginFromSearch, redeemPreviewLogin, stripPreviewLogin } from '../utils/previewAuth'

interface UserProfile {
  id: string
  email: string
  credits: number
  username?: string | null
  created_at: string
  updated_at: string
}

interface AuthContextType {
  user: User | null
  session: Session | null
  loading: boolean
  userProfile: UserProfile | null
  isSupabaseConfigured: boolean
  signIn: (email: string, password: string) => Promise<{ error: AuthError | null }>
  signUp: (email: string, password: string) => Promise<{ error: AuthError | null }>
  signOut: () => Promise<{ error: AuthError | null }>
  signInWithOtp: (email: string, redirectPath?: string) => Promise<{ error: AuthError | null }>
  verifyOtp: (email: string, token: string) => Promise<{ error: AuthError | null }>
  signInWithGoogle: (redirectPath?: string) => Promise<{ error: AuthError | null }>
  refreshUserProfile: () => Promise<void>
  deductCredits: (amount: number) => Promise<{ error: any | null; success: boolean }>
  updateUsername: (username: string) => Promise<{ error: any | null; success: boolean }>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

// Claim any generations this browser created while logged out, reassigning them
// to the now-authenticated user. Claims are by generation_id (a secret UUID the
// client recorded at creation), so this is safe and deterministic — unlike the
// old IP-hash bulk migration which could grab other users' anonymous rows.
async function claimPendingAnonymousGenerations(accessToken: string) {
  const ids = getAnonymousGenerationIds()
  if (ids.length === 0) return
  for (const id of ids) {
    try {
      await ClaimGenerationApiService.claimGeneration(id, accessToken)
      removeAnonymousGenerationId(id)
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      // 403 (owned by someone else) / 404 (deleted) are permanent — stop
      // retrying them. Transient/network errors are kept for the next login.
      if (message.includes('403') || message.includes('404')) {
        removeAnonymousGenerationId(id)
      } else {
        console.warn('Failed to claim anonymous generation, will retry later:', id, error)
      }
    }
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null)

  const fetchUserProfile = async (userEmail: string) => {
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('email', userEmail)
        .single()

      if (error) {
        console.error('Error fetching user profile:', error)
        setUserProfile(null)
        return
      }

      setUserProfile(data)
    } catch (error) {
      console.error('Error fetching user profile:', error)
      setUserProfile(null)
    }
  }

  const refreshUserProfile = async () => {
    if (user?.email) {
      await fetchUserProfile(user.email)
    }
  }
  const deductCredits = async (amount: number) => {
    if (!user?.email || !userProfile) {
      return { error: 'No user or profile found', success: false }
    }

    if (userProfile.credits < amount) {
      return { error: 'Insufficient credits', success: false }
    }

    try {
      const { error } = await supabase
        .from('user_profiles')
        .update({ 
          credits: userProfile.credits - amount,
          updated_at: new Date().toISOString()
        })
        .eq('email', user.email)

      if (error) {
        return { error: error.message || 'Database error', success: false }
      }

      // Update local state
      setUserProfile(prev => prev ? {
        ...prev,
        credits: prev.credits - amount
      } : null)

      return { error: null, success: true }
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Unknown error', success: false }
    }
  }

  const updateUsername = async (username: string) => {
    if (!user?.email || !userProfile) {
      return { error: 'No user or profile found', success: false }
    }

    const trimmed = username.trim()
    if (!trimmed) {
      return { error: 'Username cannot be empty', success: false }
    }

    const accessToken = session?.access_token
    if (!accessToken) {
      return { error: 'Not authenticated', success: false }
    }

    try {
      const { username: savedUsername } = await UpdateUsernameApiService.updateUsername(
        trimmed,
        accessToken
      )

      setUserProfile(prev => prev ? { ...prev, username: savedUsername } : null)
      return { error: null, success: true }
    } catch (error) {
      if (error instanceof UsernameTakenError) {
        return { error: 'Username is already taken', success: false }
      }
      return {
        error: error instanceof Error ? error.message : 'Unknown error',
        success: false,
      }
    }
  }

  useEffect(() => {
    let active = true
    const initialize = async () => {
      const previewLogin = previewLoginFromSearch(window.location.search)
      if (previewLogin) {
        const error = await redeemPreviewLogin(supabase.auth, previewLogin)
        if (error) console.warn('Preview sign-in could not be completed:', error)
        window.history.replaceState(null, '', `${window.location.pathname}${stripPreviewLogin(window.location.search)}`)
      }
      const { data: { session } } = await supabase.auth.getSession()
      if (!active) return
      setSession(session)
      setUser(session?.user ?? null)
      if (session?.user?.email) {
        fetchUserProfile(session.user.email)
      }
      if (session?.access_token) {
        void claimPendingAnonymousGenerations(session.access_token)
      }
      setLoading(false)
    }
    void initialize()

    // Listen for auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      setUser(session?.user ?? null)
      if (session?.user?.email) {
        fetchUserProfile(session.user.email)
      } else {
        setUserProfile(null)
      }
      if (session?.access_token) {
        void claimPendingAnonymousGenerations(session.access_token)
      }
      setLoading(false)
    })

    return () => { active = false; subscription.unsubscribe() }
  }, [])

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })
    return { error }
  }

  const signUp = async (email: string, password: string) => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/dashboard`
      }
    })
    return { error }
  }

  const signOut = async () => {
    // Clear client state immediately so the UI reflects a logged-out state
    // regardless of what the server does.
    setSession(null)
    setUser(null)
    setUserProfile(null)

    try {
      // Attempt a local sign out (no global revoke). This clears the persisted
      // session from storage. We swallow any error because a stale/expired token
      // makes the server revoke call return 403 — which must not block logout.
      const { error } = await supabase.auth.signOut({ scope: 'local' })
      if (error) {
        console.warn('signOut returned an error (clearing session anyway):', error.message)
      }
    } catch (err) {
      console.warn('signOut threw (clearing session anyway):', err)
    }

    // Fallback: ensure any persisted Supabase auth tokens are removed even if
    // the SDK call failed before it could clear storage.
    try {
      Object.keys(window.localStorage)
        .filter((key) => key.startsWith('sb-') && key.endsWith('-auth-token'))
        .forEach((key) => window.localStorage.removeItem(key))
    } catch {
      // localStorage may be unavailable in some environments; ignore.
    }

    return { error: null }
  }

  const signInWithOtp = async (email: string, redirectPath?: string) => {
    const safePath = redirectPath && redirectPath.startsWith('/') ? redirectPath : '/dashboard'
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: `${window.location.origin}${safePath}`
      }
    })
    return { error }
  }

  const verifyOtp = async (email: string, token: string) => {
    const { error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: 'email'
    })
    return { error }
  }

  const signInWithGoogle = async (redirectPath?: string) => {
    const safePath = redirectPath && redirectPath.startsWith('/') ? redirectPath : '/dashboard'
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}${safePath}`
      }
    })
    return { error }
  }

  const value: AuthContextType = {
    user,
    session,
    loading,
    userProfile,
    isSupabaseConfigured,
    signIn,
    signUp,
    signOut,
    signInWithOtp,
    verifyOtp,
    signInWithGoogle,
    refreshUserProfile,
    deductCredits,
    updateUsername,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
