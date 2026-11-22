'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck, Lock, Mail, Loader2, X, AlertCircle } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';

export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<number>(0);
  const errorTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const showError = useCallback((msg: string) => {
    if (errorTimeoutRef.current) {
      clearTimeout(errorTimeoutRef.current);
    }
    setErrorMsg(msg);
    setErrorKey((prev) => prev + 1);
    errorTimeoutRef.current = setTimeout(() => {
      setErrorMsg(null);
      errorTimeoutRef.current = null;
    }, 5000);
  }, []);

  const clearError = useCallback(() => {
    if (errorTimeoutRef.current) {
      clearTimeout(errorTimeoutRef.current);
      errorTimeoutRef.current = null;
    }
    setErrorMsg(null);
  }, []);

  useEffect(() => {
    return () => {
      if (errorTimeoutRef.current) {
        clearTimeout(errorTimeoutRef.current);
      }
    };
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    clearError();

    try {
      const supabase = createClient();
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error) throw error;

      if (data.user?.app_metadata?.role !== 'admin') {
        throw new Error('This account does not have administrator privileges.');
      }

      router.push('/admin');
    } catch (err: any) {
      showError(err.message || 'Login failed.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[#0E1621] p-4 text-white">
      <div className="w-full max-w-sm rounded-2xl bg-[#17212B] p-6 border border-[#242F3D] shadow-2xl">
        <div className="flex flex-col items-center text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[#5288C1]/20 text-[#5288C1]">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <h1 className="text-lg font-semibold tracking-tight">Admin Governance</h1>
          <p className="mt-1 text-xs text-[#7E90A3]">Sign in with your administrator credentials</p>
        </div>

        {errorMsg && (
          <div
            key={errorKey}
            className="relative mt-4 flex items-center justify-between gap-3 overflow-hidden rounded-xl bg-red-950/70 p-3 text-xs text-red-200 border border-red-800/50 shadow-lg animate-in fade-in duration-200"
          >
            <div className="flex items-center gap-2 pr-2">
              <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
              <span className="leading-snug">{errorMsg}</span>
            </div>
            <button
              type="button"
              onClick={clearError}
              className="shrink-0 rounded p-1 text-red-400 hover:bg-red-900/40 hover:text-white transition"
              aria-label="Dismiss error"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <div className="absolute bottom-0 left-0 h-0.5 w-full bg-red-500/80 animate-shrink-5s" />
          </div>
        )}

        <form onSubmit={handleLogin} className="mt-5 space-y-3.5">
          <div className="relative">
            <Mail className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-[#7E90A3]" />
            <input
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (errorMsg) clearError();
              }}
              placeholder="admin@chataf.com"
              required
              className="w-full rounded-xl bg-[#242F3D] py-2.5 pl-9 pr-3 text-xs text-white placeholder-[#7E90A3] outline-none transition focus:ring-1 focus:ring-[#5288C1]"
            />
          </div>

          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-[#7E90A3]" />
            <input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (errorMsg) clearError();
              }}
              placeholder="Password"
              required
              className="w-full rounded-xl bg-[#242F3D] py-2.5 pl-9 pr-3 text-xs text-white placeholder-[#7E90A3] outline-none transition focus:ring-1 focus:ring-[#5288C1]"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="flex w-full items-center justify-center rounded-xl bg-[#5288C1] py-2.5 text-xs font-medium text-white transition hover:bg-[#4372a3] disabled:opacity-50"
          >
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Sign In as Admin'}
          </button>
        </form>
      </div>
    </div>
  );
}
