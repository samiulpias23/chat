'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import { disablePush, syncPush } from '@/lib/push';

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

        if (!currentUser) {
          const { data: anonData, error: anonErr } = await supabase.auth.signInAnonymously();
          if (anonErr) {
            setAuthError(
              /disabled/i.test(anonErr.message)
                ? 'Guest sign-in is turned off for this app. Enable "Allow anonymous sign-ins" in Supabase Auth settings.'
                : 'Could not start a session. Check your connection and reload.'
            );
          } else {
            currentUser = anonData.user;
          }
        }

        if (currentUser) {
          setUser(currentUser);
          setIsAnonymous(Boolean(currentUser.is_anonymous));

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
        setIsAnonymous(Boolean(session.user.is_anonymous));
      } else {
        setUser(null);
        setIsAnonymous(true);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  // A device's push subscription follows whichever identity is signed in on it
  useEffect(() => {
    if (user?.id) syncPush().catch(() => {});
  }, [user?.id]);

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
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password: pass,
    });

    if (!error && data.session && data.user) {
      setUser(data.user);
      setIsAnonymous(false);
    }
    return { error };
  };

  const signUpWithEmail = async (email: string, pass: string) => {
    try {
      const supabase = createClient();
      const { data, error } = await supabase.auth.signUp({ email: email.trim(), password: pass });
      if (error) return { error };
      // With email confirmation on, there is no session until the user clicks the link.
      if (!data.session) {
        return { error: new Error('Check your email to confirm your account, then sign in.') };
      }
      setUser(data.user);
      setIsAnonymous(false);
      return { error: null };
    } catch (err: any) {
      return { error: err };
    }
  };

  const signOut = async () => {
    const supabase = createClient();
    await disablePush().catch(() => {});
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
