'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';

interface AuthContextType {
  user: User | null;
  displayName: string;
  isAnonymous: boolean;
  isLoading: boolean;
  updateDisplayName: (name: string) => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<{ error: any }>;
  signUpWithEmail: (email: string, password: string) => Promise<{ error: any }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  displayName: '',
  isAnonymous: true,
  isLoading: true,
  updateDisplayName: async () => {},
  signInWithEmail: async () => ({ error: null }),
  signUpWithEmail: async () => ({ error: null }),
  signOut: async () => {},
});

let initPromise: Promise<void> | null = null;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [displayName, setDisplayName] = useState<string>('');
  const [isAnonymous, setIsAnonymous] = useState<boolean>(true);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();

    async function initAuth() {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        let currentUser: User | null = session?.user ?? null;

        // Attempt silent guest session initialization on first visit if no session exists
        if (!currentUser) {
          try {
            // 1. Try native anonymous sign-in if enabled
            const { data: anonData, error: anonErr } = await supabase.auth.signInAnonymously();
            if (!anonErr && anonData.user) {
              currentUser = anonData.user;
            } else {
              // 2. Seamlessly issue an auto-confirmed guest account
              const res = await fetch('/api/auth/guest', { method: 'POST' });
              if (res.ok) {
                const guestData = await res.json();
                if (guestData.email && guestData.password) {
                  const { data: signinData } = await supabase.auth.signInWithPassword({
                    email: guestData.email,
                    password: guestData.password,
                  });
                  if (signinData?.user) {
                    currentUser = signinData.user;
                  }
                }
              }
            }
          } catch (e) {
            console.error('Silent guest session error:', e);
          }
        }

        if (currentUser) {
          setUser(currentUser);
          const isGuest = Boolean(
            currentUser.is_anonymous ||
            currentUser.app_metadata?.is_guest ||
            currentUser.user_metadata?.is_guest ||
            currentUser.email?.endsWith('@guest.chataf.internal')
          );
          setIsAnonymous(isGuest);

          // Check or create profile
          const { data: profile } = await supabase
            .from('profiles')
            .select('display_name')
            .eq('id', currentUser.id)
            .single();

          if (profile?.display_name) {
            setDisplayName(profile.display_name);
            localStorage.setItem('chataf_display_name', profile.display_name);
          } else {
            const cachedName =
              localStorage.getItem('chataf_display_name') || `User_${currentUser.id.slice(0, 4).toUpperCase()}`;
            await supabase.from('profiles').upsert({
              id: currentUser.id,
              display_name: cachedName,
            });
            setDisplayName(cachedName);
            localStorage.setItem('chataf_display_name', cachedName);
          }
        }
      } catch (err) {
        console.error('Failed to initialize session:', err);
      }
    }

    // Dedupe: React StrictMode runs effects twice in dev, which would create two anonymous users.
    initPromise ??= initAuth().finally(() => {
      initPromise = null;
    });
    initPromise.finally(() => setIsLoading(false));

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        setUser(session.user);
        const isRealUser = Boolean(session.user.email && !session.user.is_anonymous && !session.user.app_metadata?.is_guest);
        setIsAnonymous(!isRealUser);
      } else {
        setUser(null);
        setIsAnonymous(true);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const updateDisplayName = async (name: string) => {
    if (!user || !name.trim()) return;
    const supabase = createClient();
    const cleanName = name.trim().slice(0, 50);

    const { error } = await supabase
      .from('profiles')
      .upsert({ id: user.id, display_name: cleanName });

    if (!error) {
      setDisplayName(cleanName);
      localStorage.setItem('chataf_display_name', cleanName);
    }
  };

  const signInWithEmail = async (email: string, pass: string) => {
    const supabase = createClient();
    let { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password: pass,
    });

    // If unconfirmed error occurs, auto-confirm via API and retry
    if (error && error.message?.toLowerCase().includes('confirm')) {
      await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password: pass }),
      });
      const retry = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password: pass,
      });
      data = retry.data;
      error = retry.error;
    }

    if (!error && data.session && data.user) {
      setUser(data.user);
      setIsAnonymous(false);
    }
    return { error };
  };

  const signUpWithEmail = async (email: string, pass: string) => {
    try {
      // 1. Register with auto-confirmation on server
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password: pass }),
      });
      const result = await res.json();
      if (!res.ok || result.error) {
        return { error: new Error(result.error || 'Registration failed.') };
      }

      // 2. Immediately sign in to establish active client session and JWT tokens
      const supabase = createClient();
      const { data, error: signInErr } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password: pass,
      });

      if (signInErr) {
        return { error: signInErr };
      }

      if (data.session && data.user) {
        setUser(data.user);
        setIsAnonymous(false);
      }
      return { error: null };
    } catch (err: any) {
      return { error: err };
    }
  };

  const signOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    setUser(null);
    setIsAnonymous(true);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        displayName,
        isAnonymous,
        isLoading,
        updateDisplayName,
        signInWithEmail,
        signUpWithEmail,
        signOut,
      }}
    >
      {authError && (
        <div role="alert" className="fixed inset-x-0 top-0 z-50 bg-red-950 p-3 text-center text-xs text-red-200">
          {authError}
        </div>
      )}
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
