'use client';

import { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  User,
  Shield,
  Check,
  Copy,
  ExternalLink,
  Clock,
  LogOut,
  KeyRound,
  Loader2,
  AlertCircle,
  X,
  Plus,
  ArrowRight,
  ShieldAlert,
  Sparkles,
  Sliders,
  ChevronDown,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/components/auth/AuthProvider';
import { generateSalt, deriveKeysFromPassword, createAndWrapRoomKey, toShortUserId } from '@/lib/crypto';
import { formatAppDate } from '@/lib/formatDate';
import { getSecuritySettings, saveSecuritySettings, ClientSecuritySettings } from '@/lib/securitySettings';

interface UserOrder {
  id: string;
  room_id: string;
  duration_months: number;
  amount_usd: number;
  tx_hash: string;
  status: 'pending' | 'held' | 'approved' | 'rejected';
  admin_notes: string | null;
  created_at: string;
  rooms?: {
    id: string;
    name: string;
    status: string;
    expires_at: string | null;
    created_at: string;
  };
}

function ProfileContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const justOrdered = searchParams?.get('ordered') === 'true';

  const {
    user,
    displayName,
    isAnonymous,
    updateDisplayName,
    signOut,
  } = useAuth();

  const [nameInput, setNameInput] = useState(displayName);
  const [isSaved, setIsSaved] = useState(false);
  const [copiedId, setCopiedId] = useState(false);

  // Client Security & Auto-Lock settings
  const [securitySettings, setSecuritySettings] = useState<ClientSecuritySettings>(() => getSecuritySettings());
  const [savedSettingsNotice, setSavedSettingsNotice] = useState(false);

  const updateSetting = <K extends keyof ClientSecuritySettings>(
    key: K,
    val: ClientSecuritySettings[K]
  ) => {
    const updated = { ...securitySettings, [key]: val };
    setSecuritySettings(updated);
    saveSecuritySettings(updated);
    setSavedSettingsNotice(true);
    setTimeout(() => setSavedSettingsNotice(false), 2000);
  };

  // Orders and Rooms history
  const [orders, setOrders] = useState<UserOrder[]>([]);
  const [isLoadingOrders, setIsLoadingOrders] = useState(true);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);

  // Setup Password modal for rooms in 'unlocked_setup'
  const [setupRoomId, setSetupRoomId] = useState<string | null>(null);
  const [setupRoomName, setSetupRoomName] = useState<string>('');
  const [setupPassword, setSetupPassword] = useState('');
  const [setupConfirm, setSetupConfirm] = useState('');
  const [isSettingUpKeys, setIsSettingUpKeys] = useState(false);

  // Auto-dismissing error state
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

  useEffect(() => {
    setNameInput(displayName);
  }, [displayName]);

  // Fetch user orders & rooms
  const fetchOrders = async () => {
    if (!user) {
      setOrders([]);
      setIsLoadingOrders(false);
      return;
    }

    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from('room_orders')
        .select('id, room_id, duration_months, amount_usd, tx_hash, status, admin_notes, created_at, rooms(id, name, status, expires_at, created_at)')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (!error && data) {
        setOrders(data as unknown as UserOrder[]);
      }
    } catch (err) {
      console.error('Failed to load user orders:', err);
    } finally {
      setIsLoadingOrders(false);
    }
  };

  useEffect(() => {
    fetchOrders();

    if (!user) return;
    const supabase = createClient();

    // Subscribe to realtime updates for user's orders
    const channel = supabase
      .channel('user-orders-sync')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'room_orders', filter: `user_id=eq.${user.id}` },
        () => {
          fetchOrders();
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rooms', filter: `owner_id=eq.${user.id}` },
        () => {
          fetchOrders();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user]);

  const handleSaveName = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameInput.trim()) return;
    await updateDisplayName(nameInput);
    setIsSaved(true);
    setTimeout(() => setIsSaved(false), 2000);
  };

  const copyUserId = () => {
    if (!user) return;
    navigator.clipboard.writeText(toShortUserId(user.id));
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 2000);
  };

  const handleSignOut = async () => {
    await signOut();
    router.push('/rooms');
  };

  // Setup password for unlocked_setup room
  const handleSetupPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!setupRoomId || isSettingUpKeys) return;

    if (setupPassword.length < 6) {
      showError('Password must be at least 6 characters.');
      return;
    }
    if (setupPassword !== setupConfirm) {
      showError('Passwords do not match.');
      return;
    }

    setIsSettingUpKeys(true);
    clearError();

    try {
      const supabase = createClient();
      const salt = generateSalt();
      const { kek, authToken } = await deriveKeysFromPassword(setupPassword, salt);
      const { wrappedKey, wrappedIv } = await createAndWrapRoomKey(kek, setupRoomId);

      const { error } = await supabase.rpc('setup_room_e2ee', {
        p_room_id: setupRoomId,
        p_kdf_salt: salt,
        p_wrapped_key: wrappedKey,
        p_wrapped_iv: wrappedIv,
        p_auth_token: authToken,
      });

      if (error) throw error;

      setSetupRoomId(null);
      setSetupPassword('');
      setSetupConfirm('');
      await fetchOrders();
    } catch (err: any) {
      showError(err.message || 'Key setup failed.');
    } finally {
      setIsSettingUpKeys(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col px-4 pt-6 pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight text-white">My Profile</h1>
        {!isAnonymous && (
          <button
            onClick={handleSignOut}
            className="flex items-center gap-1.5 rounded-lg bg-[#242F3D] px-2.5 py-1 text-xs text-[#7E90A3] hover:text-red-400 transition"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span>Sign Out</span>
          </button>
        )}
      </div>

      {/* Auto-Dismissing Error Alert */}
      {errorMsg && (
        <div
          key={errorKey}
          className="relative mt-3 flex items-center justify-between gap-3 overflow-hidden rounded-xl bg-red-950/70 p-3 text-xs text-red-200 border border-red-800/50 shadow-lg animate-in fade-in duration-200"
        >
          <div className="flex items-center gap-2 pr-2">
            <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
            <span className="leading-snug">{errorMsg}</span>
          </div>
          <button
            type="button"
            onClick={clearError}
            className="shrink-0 rounded p-1 text-red-400 hover:bg-red-900/40 hover:text-white transition"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <div className="absolute bottom-0 left-0 h-0.5 w-full bg-red-500/80 animate-shrink-5s" />
        </div>
      )}

      {/* Order Success Toast banner */}
      {justOrdered && (
        <div className="mt-3 rounded-xl bg-[#4ADE80]/15 p-3.5 text-xs text-[#4ADE80] border border-[#4ADE80]/30 flex items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0" />
          <span>Your room order has been submitted! It is now pending admin confirmation.</span>
        </div>
      )}

      {/* Profile Card */}
      <div className="mt-4 rounded-2xl bg-[#17212B] p-5 border border-[#242F3D]">
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#242F3D] text-xl font-bold text-[#5288C1]">
            {displayName.charAt(0).toUpperCase() || 'U'}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-medium text-white">{displayName}</h2>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full bg-[#4ADE80]" />
              <span className="text-xs text-[#7E90A3]">
                {user?.email ? user.email : 'Active ChatAf Session'}
              </span>
            </div>
          </div>
        </div>

        {/* User ID copy */}
        <div className="mt-4 flex items-center justify-between rounded-xl bg-[#0E1621] p-3 border border-[#242F3D]">
          <div className="min-w-0">
            <p className="text-[10px] text-[#7E90A3] uppercase tracking-wider font-semibold">User ID (8-Digit)</p>
            <p className="text-sm font-mono font-bold text-white tracking-wider">{toShortUserId(user?.id)}</p>
            <p className="truncate text-[10px] font-mono text-[#7E90A3] mt-0.5">Full UUID: {user?.id || '...'}</p>
          </div>
          <button
            onClick={copyUserId}
            className="ml-2 flex items-center gap-1 rounded-lg bg-[#242F3D] px-2.5 py-1.5 text-xs text-[#5288C1] transition hover:bg-[#2b3745]"
          >
            {copiedId ? <Check className="h-3.5 w-3.5 text-[#4ADE80]" /> : <Copy className="h-3.5 w-3.5" />}
            <span className="text-[11px]">{copiedId ? 'Copied' : 'Copy ID'}</span>
          </button>
        </div>

        {/* Edit Display Name */}
        <form onSubmit={handleSaveName} className="mt-4 space-y-2">
          <label className="block text-xs font-medium text-[#7E90A3]">Edit Display Name</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="Your display name"
              maxLength={50}
              className="flex-1 rounded-xl bg-[#242F3D] px-3.5 py-2 text-xs text-white placeholder-[#7E90A3] outline-none transition focus:ring-1 focus:ring-[#5288C1]"
            />
            <button
              type="submit"
              disabled={!nameInput.trim() || nameInput === displayName}
              className="rounded-xl bg-[#5288C1] px-4 py-2 text-xs font-medium text-white transition hover:bg-[#4372a3] disabled:opacity-40"
            >
              {isSaved ? 'Saved!' : 'Save'}
            </button>
          </div>
        </form>
      </div>

      {/* CLIENT SECURITY & AUTO-LOCK SETTINGS */}
      <div className="mt-5 rounded-2xl bg-[#17212B] p-5 border border-[#242F3D] space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sliders className="h-4 w-4 text-[#5288C1]" />
            <h3 className="text-sm font-semibold text-white">Security & Auto-Lock Settings</h3>
          </div>
          {savedSettingsNotice && (
            <span className="flex items-center gap-1 rounded-full bg-[#4ADE80]/20 px-2 py-0.5 text-[10px] font-medium text-[#4ADE80] border border-[#4ADE80]/30 animate-in fade-in">
              <Check className="h-3 w-3" />
              Saved
            </span>
          )}
        </div>
        <p className="text-[11px] text-[#7E90A3] leading-relaxed">
          Configure client-side RAM key wiping and auto-lock behaviors on this device.
        </p>

        {/* Setting 1: AFK Inactivity Auto-Lock */}
        <div className="rounded-xl bg-[#0E1621] p-3.5 border border-[#242F3D] space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-white">Inactivity (AFK) Auto-Lock</p>
              <p className="text-[10px] text-[#7E90A3]">Wipe RAM keys after no user input</p>
            </div>
            {/* Toggle switch */}
            <button
              type="button"
              onClick={() => updateSetting('afkLockEnabled', !securitySettings.afkLockEnabled)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                securitySettings.afkLockEnabled ? 'bg-[#5288C1]' : 'bg-[#242F3D]'
              }`}
              aria-label="Toggle AFK Auto-Lock"
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  securitySettings.afkLockEnabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {securitySettings.afkLockEnabled && (
            <div className="space-y-1.5 pt-1">
              <label className="text-[10px] uppercase font-bold text-[#7E90A3] tracking-wider">
                Inactivity Timeout
              </label>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
                {[
                  { label: '15s', sec: 15 },
                  { label: '30s', sec: 30 },
                  { label: '1m', sec: 60 },
                  { label: '2m', sec: 120 },
                  { label: '5m', sec: 300 },
                  { label: '10m', sec: 600 },
                ].map((item) => (
                  <button
                    key={item.sec}
                    type="button"
                    onClick={() => updateSetting('afkTimeoutSeconds', item.sec)}
                    className={`rounded-lg py-1.5 text-xs font-medium transition text-center ${
                      securitySettings.afkTimeoutSeconds === item.sec
                        ? 'bg-[#5288C1] text-white shadow'
                        : 'bg-[#17212B] text-[#7E90A3] hover:text-white hover:bg-[#242F3D]'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Setting 2: Background / Minimize Auto-Lock */}
        <div className="rounded-xl bg-[#0E1621] p-3.5 border border-[#242F3D] space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-white">App Minimize / Background Auto-Lock</p>
              <p className="text-[10px] text-[#7E90A3]">Wipe keys when switching apps or locking screen</p>
            </div>
            {/* Toggle switch */}
            <button
              type="button"
              onClick={() => updateSetting('minimizeLockEnabled', !securitySettings.minimizeLockEnabled)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                securitySettings.minimizeLockEnabled ? 'bg-[#5288C1]' : 'bg-[#242F3D]'
              }`}
              aria-label="Toggle Minimize Auto-Lock"
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  securitySettings.minimizeLockEnabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {securitySettings.minimizeLockEnabled && (
            <div className="space-y-1.5 pt-1">
              <label className="text-[10px] uppercase font-bold text-[#7E90A3] tracking-wider">
                Minimize Grace Period
              </label>
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
                {[
                  { label: 'Immediate', sec: 0 },
                  { label: '10s', sec: 10 },
                  { label: '30s', sec: 30 },
                  { label: '1m', sec: 60 },
                  { label: '5m', sec: 300 },
                ].map((item) => (
                  <button
                    key={item.sec}
                    type="button"
                    onClick={() => updateSetting('minimizeTimeoutSeconds', item.sec)}
                    className={`rounded-lg py-1.5 text-xs font-medium transition text-center ${
                      securitySettings.minimizeTimeoutSeconds === item.sec
                        ? 'bg-[#5288C1] text-white shadow'
                        : 'bg-[#17212B] text-[#7E90A3] hover:text-white hover:bg-[#242F3D]'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* SECTION: ROOM PURCHASE & RENEWAL HISTORY (COLLAPSIBLE) */}
      <div className="mt-5 rounded-2xl bg-[#17212B] p-4 border border-[#242F3D] space-y-3">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setIsHistoryOpen(!isHistoryOpen)}
            className="flex items-center gap-2 text-left group"
          >
            <Clock className="h-4 w-4 text-[#5288C1]" />
            <h3 className="text-sm font-semibold text-white group-hover:text-[#5288C1] transition">
              Room Purchase / Renewal History
            </h3>
            {orders.length > 0 && (
              <span className="rounded-full bg-[#242F3D] px-2 py-0.5 text-[10px] font-medium text-[#7E90A3]">
                {orders.length}
              </span>
            )}
            <ChevronDown
              className={`h-4 w-4 text-[#7E90A3] transition-transform duration-200 ${
                isHistoryOpen ? 'rotate-180 text-white' : ''
              }`}
            />
          </button>

          <Link
            href="/rooms/new"
            className="flex items-center gap-1 rounded-lg bg-[#242F3D] px-2.5 py-1 text-xs font-medium text-[#5288C1] hover:text-white transition"
          >
            <Plus className="h-3 w-3" />
            <span>New Room</span>
          </Link>
        </div>

        {isHistoryOpen && (
          <div className="pt-2 border-t border-[#242F3D]/60 space-y-3 animate-in fade-in duration-200">
            {isLoadingOrders ? (
              <div className="flex items-center justify-center py-6 text-[#7E90A3]">
                <Loader2 className="h-5 w-5 animate-spin text-[#5288C1]" />
              </div>
            ) : orders.length === 0 ? (
              <div className="py-4 text-center text-[#7E90A3]">
                <p className="text-xs">No room purchase history yet.</p>
                <Link
                  href="/rooms/new"
                  className="mt-3 inline-block rounded-xl bg-[#5288C1] px-4 py-2 text-xs font-medium text-white hover:bg-[#4372a3]"
                >
                  Create Your First Room ($1/mo)
                </Link>
              </div>
            ) : (
              <div className="space-y-3">
                {orders.map((order) => {
                  const room = order.rooms;
                  const isLive = room?.status === 'active';
                  const needsKeySetup = room?.status === 'unlocked_setup';

                  return (
                    <div
                      key={order.id}
                      className="rounded-2xl bg-[#0E1621] p-3.5 border border-[#242F3D] shadow-sm space-y-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h4 className="text-sm font-semibold text-white">
                            {room?.name || 'Encrypted Room'}
                          </h4>
                          <p className="text-[11px] text-[#7E90A3]">
                            {order.duration_months} mo (${order.amount_usd} USD) · {formatAppDate(order.created_at)}
                          </p>
                        </div>

                        {/* Status Badge */}
                        <div className="shrink-0">
                          {order.status === 'pending' && (
                            <span className="flex items-center gap-1 rounded-full bg-amber-500/20 px-2.5 py-0.5 text-[10px] font-semibold text-amber-400 border border-amber-500/30">
                              <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                              Pending Approval
                            </span>
                          )}
                          {order.status === 'approved' && isLive && (
                            <span className="flex items-center gap-1 rounded-full bg-[#4ADE80]/20 px-2.5 py-0.5 text-[10px] font-semibold text-[#4ADE80] border border-[#4ADE80]/30">
                              <Check className="h-3 w-3" />
                              Active & Live
                            </span>
                          )}
                          {order.status === 'approved' && needsKeySetup && (
                            <span className="flex items-center gap-1 rounded-full bg-[#5288C1]/20 px-2.5 py-0.5 text-[10px] font-semibold text-[#5288C1] border border-[#5288C1]/30">
                              <KeyRound className="h-3 w-3" />
                              Setup Password
                            </span>
                          )}
                          {order.status === 'held' && (
                            <span className="rounded-full bg-orange-500/20 px-2.5 py-0.5 text-[10px] font-semibold text-orange-400">
                              Held by Admin
                            </span>
                          )}
                          {order.status === 'rejected' && (
                            <span className="rounded-full bg-red-500/20 px-2.5 py-0.5 text-[10px] font-semibold text-red-400">
                              Rejected
                            </span>
                          )}
                        </div>
                      </div>

                      {/* BscScan TxID Link */}
                      <div className="flex items-center gap-1 text-[11px] font-mono text-[#7E90A3] bg-[#17212B] p-2 rounded-xl">
                        <span className="shrink-0 text-gray-400">Tx:</span>
                        <a
                          href={`https://bscscan.com/tx/${order.tx_hash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="truncate text-[#5288C1] hover:underline flex items-center gap-1"
                        >
                          <span className="truncate">{order.tx_hash}</span>
                          <ExternalLink className="h-3 w-3 shrink-0" />
                        </a>
                      </div>

                      {/* Room expiration or admin notes */}
                      {room?.expires_at && isLive && (
                        <p className="text-[11px] text-[#7E90A3]">
                          Expires: <strong className="text-white">{formatAppDate(room.expires_at)}</strong>
                        </p>
                      )}
                      {order.admin_notes && (
                        <p className="text-[11px] text-amber-300 bg-amber-950/30 p-2 rounded-lg border border-amber-900/40">
                          Admin note: {order.admin_notes}
                        </p>
                      )}

                      {/* Action buttons */}
                      <div className="flex items-center gap-2 pt-1 border-t border-[#242F3D]">
                        {isLive && room?.id && (
                          <Link
                            href={`/chat/${room.id}`}
                            className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-[#5288C1] py-2 text-xs font-medium text-white transition hover:bg-[#4372a3]"
                          >
                            <span>Enter Room</span>
                            <ArrowRight className="h-3 w-3" />
                          </Link>
                        )}

                        {needsKeySetup && room?.id && (
                          <button
                            type="button"
                            onClick={() => {
                              setSetupRoomId(room.id);
                              setSetupRoomName(room.name);
                            }}
                            className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-amber-500 py-2 text-xs font-medium text-black transition hover:bg-amber-400"
                          >
                            <KeyRound className="h-3.5 w-3.5" />
                            <span>Set Encryption Password</span>
                          </button>
                        )}

                        {order.status === 'pending' && (
                          <p className="text-[11px] text-[#7E90A3] italic">
                            Waiting for admin confirmation on BSC network...
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* PASSWORD SETUP MODAL for unlocked_setup rooms */}
      {setupRoomId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl bg-[#17212B] p-5 border border-[#242F3D] shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-white">
                <KeyRound className="h-5 w-5 text-[#5288C1]" />
                <h3 className="text-sm font-semibold">Set E2EE Password</h3>
              </div>
              <button
                type="button"
                onClick={() => setSetupRoomId(null)}
                className="text-[#7E90A3] hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="text-xs text-[#7E90A3]">
              Set the room encryption password for <strong>{setupRoomName}</strong> to activate and generate the AES-GCM Master Key.
            </p>

            <form onSubmit={handleSetupPasswordSubmit} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-[#7E90A3]">Password</label>
                <input
                  type="password"
                  value={setupPassword}
                  onChange={(e) => setSetupPassword(e.target.value)}
                  placeholder="Min 6 characters"
                  required
                  className="mt-1 w-full rounded-xl bg-[#242F3D] px-3.5 py-2 text-xs text-white placeholder-[#7E90A3] outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-[#7E90A3]">Confirm Password</label>
                <input
                  type="password"
                  value={setupConfirm}
                  onChange={(e) => setSetupConfirm(e.target.value)}
                  placeholder="Re-enter password"
                  required
                  className="mt-1 w-full rounded-xl bg-[#242F3D] px-3.5 py-2 text-xs text-white placeholder-[#7E90A3] outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={isSettingUpKeys || setupPassword.length < 6 || setupPassword !== setupConfirm}
                className="w-full rounded-xl bg-[#5288C1] py-2.5 text-xs font-medium text-white hover:bg-[#4372a3] disabled:opacity-40"
              >
                {isSettingUpKeys ? 'Initializing E2EE...' : 'Activate Room'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Security & Privacy Card */}
      <div className="mt-5 rounded-2xl bg-[#17212B] p-5 border border-[#242F3D] space-y-2">
        <div className="flex items-center gap-2 text-white">
          <Shield className="h-4 w-4 text-[#5288C1]" />
          <h3 className="text-xs font-semibold">Privacy & Envelope Encryption</h3>
        </div>
        <p className="text-[11px] leading-relaxed text-[#7E90A3]">
          ChatAf uses client-side envelope encryption (PBKDF2 600,000 iterations + AES-256-GCM). Keys live exclusively in volatile RAM and are wiped upon 15 seconds of inactivity or backgrounding.
        </p>
      </div>

      {/* Admin Panel Quick Link */}
      <div className="mt-4 mb-4">
        <Link
          href="/admin"
          className="flex items-center justify-between rounded-xl bg-[#17212B] p-3.5 text-xs font-medium text-[#7E90A3] transition hover:bg-[#1f2b38] hover:text-white border border-[#242F3D]"
        >
          <span>Admin Governance Portal</span>
          <ExternalLink className="h-4 w-4 text-[#5288C1]" />
        </Link>
      </div>
    </div>
  );
}

export default function ProfilePage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[50vh] items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-[#5288C1]" />
        </div>
      }
    >
      <ProfileContent />
    </Suspense>
  );
}
