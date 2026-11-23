'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { Lock, ShieldAlert, KeyRound, Loader2, X, Mail, CheckCircle2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { deriveKeysFromPassword, unwrapRoomKey, generateSalt, createAndWrapRoomKey } from '@/lib/crypto';
import { BottomNavBar } from '@/components/navigation/BottomNavBar';
import { useAuth } from '@/components/auth/AuthProvider';

interface RoomLockScreenProps {
  roomId: string;
  roomName: string;
  onUnlocked: (rmk: CryptoKey) => void;
}

export function RoomLockScreen({ roomId, roomName, onUnlocked }: RoomLockScreenProps) {
  const { user } = useAuth();
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<number>(0);
  const [messageCount, setMessageCount] = useState<number>(0);
  const errorTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Forgot-password flow: 'unlock' -> 'request' (send code) -> 'verify' (code + new password)
  const [mode, setMode] = useState<'unlock' | 'request' | 'verify'>('unlock');
  const [maskedEmail, setMaskedEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [resetDone, setResetDone] = useState(false);

  // Fetch unread message count and subscribe to realtime updates while locked
  useEffect(() => {
    let isMounted = true;
    const supabase = createClient();

    async function loadCount() {
      try {
        const { data, error } = await supabase.rpc('get_room_unread_count', {
          p_room_id: roomId,
        });
        if (!error && typeof data === 'number' && isMounted) {
          setMessageCount(data);
        }
      } catch {
        // Silently ignore network hiccups on count fetch
      }
    }

    loadCount();

    const channel = supabase
      .channel(`lock_room_${roomId}_count`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `room_id=eq.${roomId}`,
        },
        (payload: any) => {
          if (isMounted) {
            // Only increment unread count if message was sent by someone else
            if (!payload?.new?.sender_id || payload.new.sender_id !== user?.id) {
              setMessageCount((prev) => prev + 1);
            }
          }
        }
      )
      .subscribe();

    return () => {
      isMounted = false;
      supabase.removeChannel(channel);
    };
  }, [roomId, user?.id]);

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

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim() || isLoading) return;

    setIsLoading(true);
    clearError();

    try {
      const supabase = createClient();

      // 1. Fetch public KDF salt
      const { data: kdfSalt, error: saltErr } = await supabase.rpc('get_room_kdf_salt', {
        p_room_id: roomId,
      });

      if (saltErr) {
        throw new Error(saltErr.message || 'Could not load room security parameters.');
      }
      if (!kdfSalt) {
        throw new Error('This room has expired or is invalid.');
      }

      // 2. Derive KEK and authToken (PBKDF2 600k + HKDF)
      const { kek, authToken } = await deriveKeysFromPassword(password, kdfSalt);

      // 3. Verify password via rate-limited RPC
      const { data: keys, error: authErr } = await supabase.rpc('verify_room_password', {
        p_room_id: roomId,
        p_auth_token: authToken,
      });

      if (authErr) {
        if (authErr.message?.includes('rate_limited')) {
          throw new Error('Too many failed attempts. Please wait 1 minute.');
        }
        if (authErr.message?.includes('auth required')) {
          throw new Error('Please sign in or create an account to enter this room.');
        }
        throw new Error(authErr.message || 'Verification failed');
      }

      if (!keys || keys.length === 0) {
        throw new Error('Incorrect room password.');
      }

      const { out_wrapped_key, out_wrapped_iv } = keys[0];

      // 4. Unwrap RMK into volatile memory
      const rmk = await unwrapRoomKey(kek, out_wrapped_key, out_wrapped_iv, roomId);

      // 5. Clear sensitive password input and notify parent
      setPassword('');
      onUnlocked(rmk);
    } catch (err: any) {
      showError(err.message || 'Failed to unlock room.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSendCode = async () => {
    if (isLoading) return;
    setIsLoading(true);
    clearError();
    try {
      const res = await fetch('/api/rooms/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not send the code.');
      setMaskedEmail(data.maskedEmail || '');
      setMode('verify');
    } catch (err: any) {
      showError(err.message || 'Could not send the code.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    if (newPassword.length < 8) return showError('Use at least 8 characters for the new password.');
    if (newPassword !== confirmPassword) return showError('The two passwords do not match.');

    setIsLoading(true);
    clearError();
    try {
      // New salt + brand-new room key: the old key cannot be recovered without the old password.
      const kdfSalt = generateSalt();
      const { kek, authToken } = await deriveKeysFromPassword(newPassword, kdfSalt);
      const { wrappedKey, wrappedIv } = await createAndWrapRoomKey(kek, roomId);

      const res = await fetch('/api/rooms/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, otp: otp.trim(), kdfSalt, wrappedKey, wrappedIv, authToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not reset the password.');

      setOtp('');
      setNewPassword('');
      setConfirmPassword('');
      setMessageCount(0);
      setResetDone(true);
      setMode('unlock');
    } catch (err: any) {
      showError(err.message || 'Could not reset the password.');
    } finally {
      setIsLoading(false);
    }
  };

  const leaveForgot = () => {
    clearError();
    setOtp('');
    setNewPassword('');
    setConfirmPassword('');
    setMode('unlock');
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#0E1621] p-4 pb-20 text-white">
      <div className="w-full max-w-sm rounded-2xl bg-[#17212B] p-6 shadow-2xl border border-[#242F3D]">
        <div className="flex flex-col items-center text-center">
          <div className="relative mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[#242F3D] text-[#5288C1]">
            <Lock className="h-7 w-7" />
            {messageCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 flex h-6 min-w-6 items-center justify-center rounded-full bg-[#5288C1] px-1.5 text-[11px] font-bold text-white ring-2 ring-[#17212B] shadow-lg animate-in zoom-in-75 duration-200">
                {messageCount > 99 ? '99+' : messageCount}
              </span>
            )}
          </div>

          <h2 className="text-xl font-semibold tracking-tight">{roomName}</h2>

          {messageCount > 0 ? (
            <div className="mt-2.5 inline-flex items-center gap-1.5 rounded-full bg-[#5288C1]/15 px-3 py-1 text-xs font-medium text-[#5288C1] border border-[#5288C1]/30">
              <span className="h-2 w-2 rounded-full bg-[#5288C1] animate-pulse" />
              <span>{messageCount} unread {messageCount === 1 ? 'message' : 'messages'}</span>
            </div>
          ) : (
            <p className="mt-1 text-xs text-[#7E90A3]">
              End-to-End Encrypted Room. Enter password to unwrap decryption keys.
            </p>
          )}
        </div>

        {errorMsg && (
          <div
            key={errorKey}
            className="relative mt-4 flex items-center justify-between gap-3 overflow-hidden rounded-xl bg-red-950/70 p-3 text-xs text-red-200 border border-red-800/50 shadow-lg animate-in fade-in duration-200"
          >
            <div className="flex items-center gap-2 pr-2">
              <ShieldAlert className="h-4 w-4 shrink-0 text-red-400" />
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

        {mode === 'unlock' && resetDone && (
          <div role="status" className="mt-4 flex items-start gap-2 rounded-xl bg-[#4ADE80]/10 p-3 text-xs text-[#4ADE80] border border-[#4ADE80]/30">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="leading-snug">Password reset. Unlock with the new password. Earlier messages were cleared because their key could not be recovered.</span>
          </div>
        )}

        {mode === 'unlock' && (
        <form onSubmit={handleUnlock} className="mt-5 space-y-4">
          <div className="relative">
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-[#7E90A3]">
              <KeyRound className="h-4 w-4" />
            </div>
            <input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (errorMsg) clearError();
              }}
              placeholder="Room Password"
              autoFocus
              disabled={isLoading}
              className="w-full rounded-xl bg-[#242F3D] py-3 pl-10 pr-4 text-base text-white placeholder-[#7E90A3] outline-none transition focus:ring-2 focus:ring-[#5288C1]"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading || !password.trim()}
            className="flex w-full items-center justify-center rounded-xl bg-[#5288C1] py-3 text-sm font-medium text-white transition hover:bg-[#4372a3] disabled:opacity-50"
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Deriving Keys & Unlocking...
              </>
            ) : (
              'Unlock Chat'
            )}
          </button>
          <button
            type="button"
            onClick={() => { clearError(); setResetDone(false); setMode('request'); }}
            className="block w-full text-center text-xs text-[#5288C1] hover:underline"
          >
            Forgot password?
          </button>
        </form>
        )}

        {mode === 'request' && (
          <div className="mt-5 space-y-4 text-center">
            <p className="text-xs leading-relaxed text-[#7E90A3]">
              We&apos;ll email a one-time code to the room owner&apos;s account email. Enter it here to set a new password.
              Because messages are end-to-end encrypted, resetting creates a new key and clears earlier messages.
            </p>
            <button
              type="button"
              onClick={handleSendCode}
              disabled={isLoading}
              className="flex w-full items-center justify-center rounded-xl bg-[#5288C1] py-3 text-sm font-medium text-white transition hover:bg-[#4372a3] disabled:opacity-50"
            >
              {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Mail className="mr-2 h-4 w-4" />}
              Email me a code
            </button>
            <button type="button" onClick={leaveForgot} className="text-xs text-[#7E90A3] hover:text-white">
              Back to unlock
            </button>
          </div>
        )}

        {mode === 'verify' && (
          <form onSubmit={handleResetPassword} className="mt-5 space-y-3">
            <p className="text-center text-xs text-[#7E90A3]">
              Code sent to <span className="text-white">{maskedEmail || 'the owner'}</span>. It expires in a few minutes.
            </p>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 10))}
              placeholder="Code from email"
              aria-label="Code from email"
              disabled={isLoading}
              className="w-full rounded-xl bg-[#242F3D] px-4 py-3 text-center text-base tracking-[0.3em] text-white placeholder:tracking-normal placeholder-[#7E90A3] outline-none transition focus:ring-2 focus:ring-[#5288C1]"
            />
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New room password"
              aria-label="New room password"
              disabled={isLoading}
              className="w-full rounded-xl bg-[#242F3D] px-4 py-3 text-base text-white placeholder-[#7E90A3] outline-none transition focus:ring-2 focus:ring-[#5288C1]"
            />
            <input
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm new password"
              aria-label="Confirm new password"
              disabled={isLoading}
              className="w-full rounded-xl bg-[#242F3D] px-4 py-3 text-base text-white placeholder-[#7E90A3] outline-none transition focus:ring-2 focus:ring-[#5288C1]"
            />
            <button
              type="submit"
              disabled={isLoading || otp.length < 6 || !newPassword || !confirmPassword}
              className="flex w-full items-center justify-center rounded-xl bg-[#5288C1] py-3 text-sm font-medium text-white transition hover:bg-[#4372a3] disabled:opacity-50"
            >
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Resetting...
                </>
              ) : (
                'Reset password'
              )}
            </button>
            <div className="flex justify-between text-xs text-[#7E90A3]">
              <button type="button" onClick={handleSendCode} disabled={isLoading} className="hover:text-white disabled:opacity-50">
                Resend code
              </button>
              <button type="button" onClick={leaveForgot} className="hover:text-white">
                Cancel
              </button>
            </div>
          </form>
        )}

        {mode === 'unlock' && (
          <p className="mt-4 text-center text-[11px] text-[#7E90A3]">
            Chat auto-locks immediately on backgrounding or after 15s of idle time.
          </p>
        )}

        <div className="mt-4 flex items-center justify-between text-xs text-[#7E90A3] border-t border-[#242F3D]/60 pt-3">
          <Link href="/rooms" className="hover:text-white transition">
            ← Back to Rooms
          </Link>
          <Link href="/profile" className="text-[#5288C1] hover:underline">
            Account / Sign In →
          </Link>
        </div>
      </div>

      {/* Always show bottom navigation when the room is locked */}
      <BottomNavBar forceShow />
    </div>
  );
}
