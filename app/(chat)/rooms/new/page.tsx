'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ShieldCheck,
  Copy,
  Check,
  Lock,
  KeyRound,
  Loader2,
  AlertCircle,
  X,
  Sparkles,
  ArrowRight,
  ArrowLeft,
  Mail,
  UserCheck,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/components/auth/AuthProvider';
import { generateSalt, deriveKeysFromPassword, createAndWrapRoomKey, generateUUID } from '@/lib/crypto';

const WALLET_ADDRESS = process.env.NEXT_PUBLIC_CRYPTO_WALLET_ADDRESS || '0xa8f5ea9431d2e2d10cb67562155e0b83bdf8082a';
const CRYPTO_NETWORK = process.env.NEXT_PUBLIC_CRYPTO_NETWORK || 'BSC (BEP20)';

export default function NewRoomPage() {
  const router = useRouter();
  const { user, isAnonymous, signInWithEmail, signUpWithEmail } = useAuth();

  // Navigation steps: 1 = Details & Password, 2 = Payment & Submit
  const [step, setStep] = useState<1 | 2>(1);

  // Form fields
  const [roomName, setRoomName] = useState('');
  const [durationMonths, setDurationMonths] = useState<number>(1);
  const [roomPassword, setRoomPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [txHash, setTxHash] = useState('');

  // Account authentication modal/gate state
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [isAuthLoading, setIsAuthLoading] = useState(false);

  // Action state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [copiedWallet, setCopiedWallet] = useState(false);

  // 5-second auto-dismissing error state
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

  const copyWallet = () => {
    navigator.clipboard.writeText(WALLET_ADDRESS);
    setCopiedWallet(true);
    setTimeout(() => setCopiedWallet(false), 2000);
  };

  // Generate valid 66-character hex test hash
  const handleGenerateTestTx = () => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    setTxHash(`0x${hex}`);
    clearError();
  };

  // Sign in / Sign up handler for room ownership
  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authEmail.trim() || !authPassword.trim() || isAuthLoading) return;
    setIsAuthLoading(true);
    clearError();

    try {
      if (authMode === 'signin') {
        const { error } = await signInWithEmail(authEmail, authPassword);
        if (error) throw error;
      } else {
        const { error } = await signUpWithEmail(authEmail, authPassword);
        if (error) throw error;
      }
    } catch (err: any) {
      showError(err.message || 'Authentication failed.');
    } finally {
      setIsAuthLoading(false);
    }
  };

  // Step 1 Validation -> Proceed to Step 2
  const handleProceedToPayment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomName.trim()) {
      showError('Please enter a room name.');
      return;
    }
    if (roomPassword.length < 6) {
      showError('Room password must be at least 6 characters.');
      return;
    }
    if (roomPassword !== confirmPassword) {
      showError('Room passwords do not match.');
      return;
    }
    clearError();
    setStep(2);
  };

  // Step 2 Submission: Atomic room + order + client-side wrapped RMK
  const handleFinalSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    let cleanTx = txHash.trim().toLowerCase();
    if (!cleanTx) {
      showError('Please enter your transaction hash.');
      return;
    }

    // Auto-prefix 0x if exactly 64 hex characters were entered
    if (!cleanTx.startsWith('0x') && cleanTx.length === 64 && /^[0-9a-f]{64}$/.test(cleanTx)) {
      cleanTx = `0x${cleanTx}`;
      setTxHash(cleanTx);
    }

    if (!cleanTx.startsWith('0x')) {
      showError("Transaction Hash must start with '0x'.");
      return;
    }

    if (cleanTx.length !== 66) {
      showError(`Invalid length: ${cleanTx.length}/66 characters. A BSC transaction hash must be exactly 66 characters starting with 0x.`);
      return;
    }

    const hexBody = cleanTx.slice(2);
    const invalidChars = hexBody.replace(/[0-9a-f]/g, '');
    if (invalidChars.length > 0) {
      const uniqueInvalid = Array.from(new Set(invalidChars)).map((c) => `'${c}'`).join(', ');
      showError(`Invalid character(s) ${uniqueInvalid}. Hex hashes only allow numbers 0-9 and letters a-f.`);
      return;
    }

    setIsSubmitting(true);
    clearError();

    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) {
        showError('Session expired. Please sign in to create a room.');
        setIsSubmitting(false);
        return;
      }

      // 1. Client-side key derivation (PBKDF2 600,000 + HKDF)
      const roomId = generateUUID();
      const salt = generateSalt();
      const { kek, authToken } = await deriveKeysFromPassword(roomPassword, salt);

      // 2. Wrap 256-bit AES-GCM RMK using roomId as AAD
      const { wrappedKey, wrappedIv } = await createAndWrapRoomKey(kek, roomId);

      // 3. Atomically create room + order + wrapped E2EE keys in Postgres
      const { data, error } = await supabase.rpc('create_room_order', {
        p_name: roomName.trim(),
        p_duration: durationMonths,
        p_tx_hash: cleanTx,
        p_room_id: roomId,
        p_kdf_salt: salt,
        p_wrapped_key: wrappedKey,
        p_wrapped_iv: wrappedIv,
        p_auth_token: authToken,
      });

      if (error) {
        if (error.message?.includes('already been used') || error.message?.includes('tx_hash')) {
          throw new Error('This transaction hash has already been submitted. Please provide a new transaction hash.');
        }
        throw error;
      }

      // Success! Redirect to profile where the order is listed with live status
      router.push('/profile?ordered=true');
    } catch (err: any) {
      showError(err.message || 'Failed to place room order.');
      setIsSubmitting(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col px-4 pt-6 pb-24">
      {/* Header */}
      <div className="flex items-center gap-2 pb-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#5288C1] text-white">
          <ShieldCheck className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-white">Create Secure Room</h1>
          <p className="text-[11px] text-[#7E90A3]">End-to-End Encrypted & Ephemeral</p>
        </div>
      </div>

      {/* Auto-Dismissing Error Alert with 5-Second Progress Bar */}
      {errorMsg && (
        <div
          key={errorKey}
          className="relative mb-4 flex items-center justify-between gap-3 overflow-hidden rounded-xl bg-red-950/70 p-3 text-xs text-red-200 border border-red-800/50 shadow-lg animate-in fade-in duration-200"
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

      {/* ACCOUNT GATE: If user is not signed in with email */}
      {isAnonymous ? (
        <div className="rounded-2xl bg-[#17212B] p-5 border border-[#242F3D] space-y-4">
          <div className="flex items-center gap-2 text-amber-400">
            <Lock className="h-5 w-5 shrink-0" />
            <h2 className="text-sm font-semibold">Account Required to Own a Room</h2>
          </div>
          <p className="text-xs text-[#7E90A3] leading-relaxed">
            Room ownership and renewal orders are permanently linked to your account. Sign in or create an account to proceed.
          </p>

          {/* Sign In vs Sign Up Tabs */}
          <div className="flex rounded-xl bg-[#0E1621] p-1 border border-[#242F3D]">
            <button
              type="button"
              onClick={() => {
                setAuthMode('signin');
                clearError();
              }}
              className={`flex-1 rounded-lg py-1.5 text-xs font-medium transition ${
                authMode === 'signin' ? 'bg-[#5288C1] text-white' : 'text-[#7E90A3] hover:text-white'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setAuthMode('signup');
                clearError();
              }}
              className={`flex-1 rounded-lg py-1.5 text-xs font-medium transition ${
                authMode === 'signup' ? 'bg-[#5288C1] text-white' : 'text-[#7E90A3] hover:text-white'
              }`}
            >
              Create Account
            </button>
          </div>

          <form onSubmit={handleAuthSubmit} className="space-y-3 pt-1">
            <div className="relative">
              <Mail className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-[#7E90A3]" />
              <input
                type="email"
                value={authEmail}
                onChange={(e) => {
                  setAuthEmail(e.target.value);
                  if (errorMsg) clearError();
                }}
                placeholder="your.email@example.com"
                required
                className="w-full rounded-xl bg-[#242F3D] py-2.5 pl-9 pr-3 text-xs text-white placeholder-[#7E90A3] outline-none transition focus:ring-1 focus:ring-[#5288C1]"
              />
            </div>

            <div className="relative">
              <Lock className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-[#7E90A3]" />
              <input
                type="password"
                value={authPassword}
                onChange={(e) => {
                  setAuthPassword(e.target.value);
                  if (errorMsg) clearError();
                }}
                placeholder="Account password"
                required
                className="w-full rounded-xl bg-[#242F3D] py-2.5 pl-9 pr-3 text-xs text-white placeholder-[#7E90A3] outline-none transition focus:ring-1 focus:ring-[#5288C1]"
              />
            </div>

            <button
              type="submit"
              disabled={isAuthLoading || !authEmail.trim() || !authPassword.trim()}
              className="flex w-full items-center justify-center rounded-xl bg-[#5288C1] py-2.5 text-xs font-medium text-white transition hover:bg-[#4372a3] disabled:opacity-40"
            >
              {isAuthLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : authMode === 'signin' ? (
                'Sign In & Continue'
              ) : (
                'Create Account & Continue'
              )}
            </button>
          </form>
        </div>
      ) : (
        /* STEP WIZARD (Authenticated User) */
        <div className="space-y-4">
          {/* User badge */}
          <div className="flex items-center justify-between rounded-xl bg-[#17212B] px-3.5 py-2 border border-[#242F3D] text-xs">
            <div className="flex items-center gap-2 text-gray-300">
              <UserCheck className="h-4 w-4 text-[#4ADE80]" />
              <span className="truncate max-w-[220px]">{user?.email}</span>
            </div>
            <span className="text-[10px] uppercase font-bold text-[#5288C1]">
              Step {step} of 2
            </span>
          </div>

          {/* STEP 1: Details & Encryption Password */}
          {step === 1 && (
            <form onSubmit={handleProceedToPayment} className="space-y-4 rounded-2xl bg-[#17212B] p-5 border border-[#242F3D]">
              <div>
                <label className="block text-xs font-medium text-[#7E90A3]">Room Name</label>
                <input
                  type="text"
                  value={roomName}
                  onChange={(e) => {
                    setRoomName(e.target.value);
                    if (errorMsg) clearError();
                  }}
                  placeholder="e.g. Secret Ops, VIP Vault"
                  maxLength={60}
                  required
                  className="mt-1.5 w-full rounded-xl bg-[#242F3D] px-3.5 py-2.5 text-xs text-white placeholder-[#7E90A3] outline-none transition focus:ring-1 focus:ring-[#5288C1]"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-[#7E90A3]">Subscription Duration</label>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {[1, 2, 3, 6, 12, 24].map((m) => (
                    <button
                      type="button"
                      key={m}
                      onClick={() => setDurationMonths(m)}
                      className={`rounded-xl py-2 text-xs font-medium transition border ${
                        durationMonths === m
                          ? 'bg-[#5288C1] text-white border-[#5288C1]'
                          : 'bg-[#242F3D] text-[#7E90A3] border-transparent hover:text-white'
                      }`}
                    >
                      {m} mo (${m})
                    </button>
                  ))}
                </div>
              </div>

              {/* Password Section */}
              <div className="pt-2 border-t border-[#242F3D] space-y-3">
                <div className="flex items-center gap-2 text-white">
                  <KeyRound className="h-4 w-4 text-[#5288C1]" />
                  <span className="text-xs font-semibold">End-to-End Encryption Password</span>
                </div>
                <p className="text-[11px] text-[#7E90A3] leading-relaxed">
                  Generates the 256-bit AES-GCM Room Master Key client-side. The server never sees this password.
                </p>

                <div>
                  <label className="block text-xs font-medium text-[#7E90A3]">Set Room Password</label>
                  <input
                    type="password"
                    value={roomPassword}
                    onChange={(e) => {
                      setRoomPassword(e.target.value);
                      if (errorMsg) clearError();
                    }}
                    placeholder="Minimum 6 characters"
                    required
                    className="mt-1.5 w-full rounded-xl bg-[#242F3D] px-3.5 py-2.5 text-xs text-white placeholder-[#7E90A3] outline-none transition focus:ring-1 focus:ring-[#5288C1]"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-[#7E90A3]">Confirm Room Password</label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => {
                      setConfirmPassword(e.target.value);
                      if (errorMsg) clearError();
                    }}
                    placeholder="Re-enter password"
                    required
                    className="mt-1.5 w-full rounded-xl bg-[#242F3D] px-3.5 py-2.5 text-xs text-white placeholder-[#7E90A3] outline-none transition focus:ring-1 focus:ring-[#5288C1]"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={!roomName.trim() || roomPassword.length < 6 || roomPassword !== confirmPassword}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-[#5288C1] py-3 text-xs font-medium text-white transition hover:bg-[#4372a3] disabled:opacity-40"
              >
                <span>Continue to Payment (${durationMonths}.00)</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </form>
          )}

          {/* STEP 2: BSC BEP20 Payment & Single Atomic Submit */}
          {step === 2 && (
            <form onSubmit={handleFinalSubmit} className="space-y-4 rounded-2xl bg-[#17212B] p-5 border border-[#242F3D]">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-white">Payment & Activation</h3>
                  <p className="text-[11px] text-[#7E90A3]">
                    {roomName} · {durationMonths} month{durationMonths > 1 ? 's' : ''} (${durationMonths}.00 USD)
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setStep(1);
                    clearError();
                  }}
                  className="flex items-center gap-1 text-xs text-[#7E90A3] hover:text-white"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  <span>Back</span>
                </button>
              </div>

              {/* Wallet Address Box */}
              <div className="rounded-xl bg-[#0E1621] p-3.5 border border-[#242F3D]">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] uppercase font-bold text-[#5288C1]">{CRYPTO_NETWORK}</span>
                  <button
                    type="button"
                    onClick={copyWallet}
                    className="flex items-center gap-1 text-[11px] text-[#5288C1] hover:text-white"
                  >
                    {copiedWallet ? <Check className="h-3 w-3 text-[#4ADE80]" /> : <Copy className="h-3 w-3" />}
                    {copiedWallet ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <p className="mt-1 font-mono text-xs break-all text-gray-200 select-all">{WALLET_ADDRESS}</p>
              </div>

              <p className="text-[11px] leading-relaxed text-[#7E90A3]">
                Send exactly <strong className="text-white">${durationMonths}.00 USD</strong> (BNB / USDT / BUSD) on <strong>{CRYPTO_NETWORK}</strong> to the address above.
              </p>

              {/* Tx Hash Input */}
              <div>
                <div className="flex items-center justify-between">
                  <label className="block text-xs font-medium text-[#7E90A3]">
                    Transaction ID / Hash (tx_hash)
                  </label>
                  <button
                    type="button"
                    onClick={handleGenerateTestTx}
                    className="flex items-center gap-1 text-[11px] font-medium text-[#5288C1] hover:text-white transition"
                    title="Generate a cryptographically valid 66-character test hash"
                  >
                    <Sparkles className="h-3 w-3" />
                    Generate Test TxID
                  </button>
                </div>
                <input
                  type="text"
                  value={txHash}
                  onChange={(e) => {
                    setTxHash(e.target.value);
                    if (errorMsg) clearError();
                  }}
                  placeholder="0x..."
                  required
                  className="mt-1.5 w-full rounded-xl bg-[#242F3D] px-3.5 py-2.5 font-mono text-xs text-white placeholder-[#7E90A3] outline-none transition focus:ring-1 focus:ring-[#5288C1]"
                />
                <div className="mt-1.5 flex items-center justify-between text-[10px] text-[#7E90A3]">
                  <span>Must be 66 characters: <code className="text-gray-300">0x</code> + 64 hex characters (0-9, a-f)</span>
                  <span className={`font-mono transition-colors ${txHash.trim().length === 66 ? 'font-semibold text-[#4ADE80]' : 'text-[#7E90A3]'}`}>
                    {txHash.trim().length}/66
                  </span>
                </div>
              </div>

              <button
                type="submit"
                disabled={isSubmitting || !txHash.trim()}
                className="flex w-full items-center justify-center rounded-xl bg-[#5288C1] py-3 text-xs font-medium text-white transition hover:bg-[#4372a3] disabled:opacity-40"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Encrypting Keys & Placing Order...
                  </>
                ) : (
                  'Submit Order & Initialize Room'
                )}
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
