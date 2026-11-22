'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  X,
  Shield,
  KeyRound,
  Copy,
  Check,
  Lock,
  LogOut,
  Clock,
  Loader2,
  AlertCircle,
  Share2,
  Users,
  UserPlus,
  Crown,
  ShieldCheck,
  Ban,
  Edit2,
  ChevronDown,
  Sparkles,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/components/auth/AuthProvider';
import { generateSalt, deriveKeysFromPassword, rotateRoomKeyWrapping, toShortUserId } from '@/lib/crypto';
import { formatAppDate } from '@/lib/formatDate';

interface RoomMember {
  user_id: string;
  display_name: string;
  role: 'owner' | 'admin' | 'member' | 'banned';
  nickname: string | null;
  joined_at: string;
}

interface RoomSettingsModalProps {
  roomId: string;
  roomName: string;
  expiresAt: string | null;
  isOwner: boolean;
  isOpen: boolean;
  onClose: () => void;
  onLockNow: () => void;
}

export function RoomSettingsModal({
  roomId,
  roomName,
  expiresAt,
  isOwner,
  isOpen,
  onClose,
  onLockNow,
}: RoomSettingsModalProps) {
  const router = useRouter();
  const { user } = useAuth();

  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const [copiedMemberId, setCopiedMemberId] = useState<string | null>(null);

  // Members list & management state
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [isLoadingMembers, setIsLoadingMembers] = useState(true);
  const [memberActionLoading, setMemberActionLoading] = useState<string | null>(null);

  // Set Nickname state
  const [editingNicknameUserId, setEditingNicknameUserId] = useState<string | null>(null);
  const [nicknameInput, setNicknameInput] = useState('');
  const [isSavingNickname, setIsSavingNickname] = useState(false);

  // Add Member by UUID state
  const [showAddMember, setShowAddMember] = useState(false);
  const [addUuidInput, setAddUuidInput] = useState('');
  const [addRoleInput, setAddRoleInput] = useState<'member' | 'admin'>('member');
  const [addNicknameInput, setAddNicknameInput] = useState('');
  const [isAddingMember, setIsAddingMember] = useState(false);
  const [addMemberSuccess, setAddMemberSuccess] = useState(false);

  // Password rotation state
  const [showRotateForm, setShowRotateForm] = useState(false);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isRotating, setIsRotating] = useState(false);
  const [rotateSuccess, setRotateSuccess] = useState(false);

  // 5-second auto-dismissing error
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

  // Fetch room members
  const loadMembers = useCallback(async () => {
    try {
      const supabase = createClient();
      const { data, error } = await supabase.rpc('get_room_members', { p_room_id: roomId });
      if (error) throw error;
      setMembers((data as RoomMember[]) || []);
    } catch (err: any) {
      console.error('Failed to load room members:', err);
    } finally {
      setIsLoadingMembers(false);
    }
  }, [roomId]);

  useEffect(() => {
    if (isOpen) {
      loadMembers();
    }
  }, [isOpen, loadMembers]);

  if (!isOpen) return null;

  // Determine current user's role in this room
  const myMember = members.find((m) => m.user_id === user?.id);
  const currentRole = myMember?.role || (isOwner ? 'owner' : 'member');
  const isOwnerUser = isOwner || currentRole === 'owner';
  const isAdminOrOwner = isOwnerUser || currentRole === 'admin';

  const copyRoomLink = () => {
    const url = `${window.location.origin}/chat/${roomId}`;
    navigator.clipboard.writeText(url);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const copyRoomId = () => {
    navigator.clipboard.writeText(roomId);
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 2000);
  };

  const copyMemberUuid = (uid: string) => {
    navigator.clipboard.writeText(uid);
    setCopiedMemberId(uid);
    setTimeout(() => setCopiedMemberId(null), 2000);
  };

  // Toggle Admin (Owner only)
  const handleToggleAdmin = async (targetUserId: string, currentTargetRole: string) => {
    const newRole = currentTargetRole === 'admin' ? 'member' : 'admin';
    setMemberActionLoading(targetUserId);
    clearError();
    try {
      const supabase = createClient();
      const { error } = await supabase.rpc('set_member_role', {
        p_room_id: roomId,
        p_user_id: targetUserId,
        p_role: newRole,
      });
      if (error) throw error;
      await loadMembers();
    } catch (err: any) {
      showError(err.message || 'Failed to update member role.');
    } finally {
      setMemberActionLoading(null);
    }
  };

  // Ban or Unban member
  const handleToggleBan = async (targetUserId: string, currentTargetRole: string) => {
    const newRole = currentTargetRole === 'banned' ? 'member' : 'banned';
    setMemberActionLoading(targetUserId);
    clearError();
    try {
      const supabase = createClient();
      const { error } = await supabase.rpc('set_member_role', {
        p_room_id: roomId,
        p_user_id: targetUserId,
        p_role: newRole,
      });
      if (error) throw error;
      await loadMembers();
    } catch (err: any) {
      showError(err.message || 'Failed to update member ban status.');
    } finally {
      setMemberActionLoading(null);
    }
  };

  // Save member nickname
  const handleSaveNickname = async (targetUserId: string) => {
    setIsSavingNickname(true);
    clearError();
    try {
      const supabase = createClient();
      const { error } = await supabase.rpc('set_member_nickname', {
        p_room_id: roomId,
        p_user_id: targetUserId,
        p_nickname: nicknameInput.trim(),
      });
      if (error) throw error;
      setEditingNicknameUserId(null);
      setNicknameInput('');
      await loadMembers();
    } catch (err: any) {
      showError(err.message || 'Failed to set nickname.');
    } finally {
      setIsSavingNickname(false);
    }
  };

  // Add Member by 8-digit User ID or UUID
  const handleAddMemberByUuid = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedInput = addUuidInput.trim();
    const isValidId = /^[0-9a-f]{8}$/i.test(trimmedInput) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmedInput);
    if (!isValidId) {
      showError('Invalid User ID format. Enter an 8-digit User ID (e.g. 9FD2CB61) or full UUID.');
      return;
    }

    setIsAddingMember(true);
    clearError();
    try {
      const supabase = createClient();
      const { error } = await supabase.rpc('add_member_by_uuid', {
        p_room_id: roomId,
        p_user_id: trimmedInput,
        p_role: addRoleInput,
        p_nickname: addNicknameInput.trim() || null,
      });
      if (error) throw error;
      setAddUuidInput('');
      setAddNicknameInput('');
      setAddRoleInput('member');
      setShowAddMember(false);
      setAddMemberSuccess(true);
      setTimeout(() => setAddMemberSuccess(false), 4000);
      await loadMembers();
    } catch (err: any) {
      showError(err.message || 'Failed to add member by UUID.');
    } finally {
      setIsAddingMember(false);
    }
  };

  // Rotate Password
  const handleRotatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!oldPassword.trim() || !newPassword.trim() || isRotating) return;

    if (newPassword.length < 6) {
      showError('New password must be at least 6 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      showError('New passwords do not match.');
      return;
    }

    setIsRotating(true);
    clearError();

    try {
      const supabase = createClient();

      // 1. Fetch current public KDF salt
      const { data: currentSalt, error: saltErr } = await supabase.rpc('get_room_kdf_salt', {
        p_room_id: roomId,
      });
      if (saltErr || !currentSalt) throw new Error('Could not fetch room security salt.');

      // 2. Derive current keys and auth token
      const { kek: oldKek, authToken: currentAuthToken } = await deriveKeysFromPassword(oldPassword, currentSalt);

      // 3. Verify current password
      const { data: keys, error: authErr } = await supabase.rpc('verify_room_password', {
        p_room_id: roomId,
        p_auth_token: currentAuthToken,
      });

      if (authErr || !keys || keys.length === 0) {
        throw new Error('Incorrect current password.');
      }

      const { out_wrapped_key, out_wrapped_iv } = keys[0];

      // 4. Generate fresh new salt and re-wrap RMK
      const newSalt = generateSalt();
      const { newWrappedKey, newWrappedIv, newAuthToken, oldAuthToken } = await rotateRoomKeyWrapping(
        oldPassword,
        currentSalt,
        out_wrapped_key,
        out_wrapped_iv,
        roomId,
        newPassword,
        newSalt
      );

      // 5. Update atomic rotation in Postgres
      const { error: rotateErr } = await supabase.rpc('rotate_room_password', {
        p_room_id: roomId,
        p_old_auth_token: oldAuthToken,
        p_new_kdf_salt: newSalt,
        p_new_wrapped_key: newWrappedKey,
        p_new_wrapped_iv: newWrappedIv,
        p_new_auth_token: newAuthToken,
      });

      if (rotateErr) throw rotateErr;

      setRotateSuccess(true);
      setShowRotateForm(false);
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setTimeout(() => setRotateSuccess(false), 4000);
    } catch (err: any) {
      showError(err.message || 'Password rotation failed.');
    } finally {
      setIsRotating(false);
    }
  };

  const initial = roomName.trim().charAt(0).toUpperCase() || 'R';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-3xl bg-[#17212B] p-5 border border-[#242F3D] shadow-2xl space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#242F3D] pb-3">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[#242F3D] text-base font-bold text-[#5288C1]">
              {initial}
            </div>
            <div>
              <h2 className="text-base font-semibold text-white leading-tight">{roomName}</h2>
              <span className="inline-flex items-center gap-1 text-[11px] text-[#4ADE80]">
                <ShieldCheck className="h-3 w-3" />
                Active · End-to-End Encrypted
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[#7E90A3] hover:bg-[#242F3D] hover:text-white transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Auto-Dismissing Error Alert */}
        {errorMsg && (
          <div
            key={errorKey}
            className="relative flex items-center justify-between gap-3 overflow-hidden rounded-xl bg-red-950/70 p-3 text-xs text-red-200 border border-red-800/50 shadow-lg animate-in fade-in duration-200"
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

        {/* Success Banners */}
        {rotateSuccess && (
          <div className="rounded-xl bg-[#4ADE80]/20 p-3 text-xs text-[#4ADE80] border border-[#4ADE80]/30 flex items-center gap-2">
            <Check className="h-4 w-4 shrink-0" />
            <span>Room password rotated successfully!</span>
          </div>
        )}
        {addMemberSuccess && (
          <div className="rounded-xl bg-[#4ADE80]/20 p-3 text-xs text-[#4ADE80] border border-[#4ADE80]/30 flex items-center gap-2">
            <Check className="h-4 w-4 shrink-0" />
            <span>Member added to room successfully!</span>
          </div>
        )}

        {/* Room Share & UUID */}
        <div className="space-y-2 rounded-2xl bg-[#0E1621] p-3.5 border border-[#242F3D]">
          <div className="flex items-center justify-between text-xs">
            <span className="text-[10px] text-[#7E90A3] uppercase font-bold tracking-wider">Room UUID</span>
            <button
              onClick={copyRoomId}
              className="flex items-center gap-1 text-[11px] text-[#5288C1] hover:underline"
            >
              {copiedId ? <Check className="h-3 w-3 text-[#4ADE80]" /> : <Copy className="h-3 w-3" />}
              {copiedId ? 'Copied' : 'Copy UUID'}
            </button>
          </div>
          <p className="truncate font-mono text-xs text-gray-300 select-all">{roomId}</p>

          <button
            onClick={copyRoomLink}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-[#242F3D] py-2 text-xs font-medium text-white transition hover:bg-[#2e3b4b]"
          >
            {copiedLink ? <Check className="h-3.5 w-3.5 text-[#4ADE80]" /> : <Share2 className="h-3.5 w-3.5 text-[#5288C1]" />}
            <span>{copiedLink ? 'Link Copied to Clipboard!' : 'Share Room Invite Link'}</span>
          </button>
        </div>

        {/* Subscription Info */}
        <div className="rounded-2xl bg-[#0E1621] p-3.5 border border-[#242F3D] space-y-1.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[#7E90A3]">
              <Clock className="h-3.5 w-3.5 text-[#5288C1]" />
              Subscription Status:
            </span>
            <span className="font-medium text-[#4ADE80]">Active</span>
          </div>
          {expiresAt && (
            <div className="flex items-center justify-between pt-1">
              <span className="text-[#7E90A3]">Expires on:</span>
              <span className="font-mono text-white">{formatAppDate(expiresAt)}</span>
            </div>
          )}
        </div>

        {/* ROOM MEMBERS MANAGEMENT */}
        <div className="rounded-2xl bg-[#0E1621] p-3.5 border border-[#242F3D] space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-[#5288C1]" />
              <span className="text-xs font-semibold text-white">
                Room Members ({members.length})
              </span>
            </div>

            {isAdminOrOwner && (
              <button
                type="button"
                onClick={() => {
                  setShowAddMember(!showAddMember);
                  clearError();
                }}
                className="flex items-center gap-1 rounded-lg bg-[#242F3D] px-2.5 py-1 text-[11px] font-medium text-[#5288C1] hover:bg-[#2e3b4b] hover:text-white transition"
              >
                <UserPlus className="h-3.5 w-3.5" />
                <span>{showAddMember ? 'Cancel' : 'Add Member'}</span>
              </button>
            )}
          </div>

          {/* Add Member Form */}
          {showAddMember && isAdminOrOwner && (
            <form
              onSubmit={handleAddMemberByUuid}
              className="space-y-2.5 rounded-xl bg-[#17212B] p-3 border border-[#242F3D] animate-in fade-in duration-200"
            >
              <div className="flex items-center gap-1 text-[11px] font-medium text-white">
                <UserPlus className="h-3.5 w-3.5 text-[#5288C1]" />
                <span>Add Member via User ID</span>
              </div>
              <p className="text-[10px] text-[#7E90A3]">
                Enter a user&apos;s 8-digit User ID (e.g. 9FD2CB61) or full UUID to grant them room access and assign their role.
              </p>

              <div>
                <label className="block text-[10px] uppercase font-semibold text-[#7E90A3]">User ID (8-Digit or UUID)</label>
                <input
                  type="text"
                  value={addUuidInput}
                  onChange={(e) => setAddUuidInput(e.target.value)}
                  placeholder="e.g. 9FD2CB61 or full UUID"
                  required
                  className="mt-1 w-full rounded-xl bg-[#242F3D] px-3 py-1.5 font-mono text-xs text-white placeholder-[#7E90A3] outline-none border border-transparent focus:border-[#5288C1]"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] uppercase font-semibold text-[#7E90A3]">Role</label>
                  <select
                    value={addRoleInput}
                    onChange={(e) => setAddRoleInput(e.target.value as 'member' | 'admin')}
                    disabled={!isOwnerUser}
                    className="mt-1 w-full rounded-xl bg-[#242F3D] px-2.5 py-1.5 text-xs text-white outline-none disabled:opacity-50"
                  >
                    <option value="member">Member</option>
                    {isOwnerUser && <option value="admin">Admin</option>}
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] uppercase font-semibold text-[#7E90A3]">Nickname (Optional)</label>
                  <input
                    type="text"
                    value={addNicknameInput}
                    onChange={(e) => setAddNicknameInput(e.target.value)}
                    placeholder="e.g. Agent007"
                    maxLength={50}
                    className="mt-1 w-full rounded-xl bg-[#242F3D] px-3 py-1.5 text-xs text-white placeholder-[#7E90A3] outline-none border border-transparent focus:border-[#5288C1]"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isAddingMember || !addUuidInput.trim()}
                className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-xl bg-[#5288C1] py-2 text-xs font-medium text-white transition hover:bg-[#4372a3] disabled:opacity-40"
              >
                {isAddingMember ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <>
                    <UserPlus className="h-3.5 w-3.5" />
                    <span>Confirm Add Member</span>
                  </>
                )}
              </button>
            </form>
          )}

          {/* Members List */}
          {isLoadingMembers ? (
            <div className="flex h-20 items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-[#5288C1]" />
            </div>
          ) : members.length === 0 ? (
            <p className="py-2 text-center text-xs text-[#7E90A3]">No members found.</p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto overscroll-contain pr-1.5">
              {members.map((member) => {
                const isMe = member.user_id === user?.id;
                const isMemberOwner = member.role === 'owner';
                const isMemberAdmin = member.role === 'admin';
                const isMemberBanned = member.role === 'banned';
                const safeName = member.nickname || member.display_name || 'User';
                const memberInitial = safeName.trim().charAt(0).toUpperCase() || 'U';
                const safeUuid = member.user_id || '';
                const truncatedUuid = safeUuid.length >= 14 ? `${safeUuid.slice(0, 8)}...${safeUuid.slice(-6)}` : safeUuid;
                const isActionLoading = memberActionLoading === member.user_id;
                const isEditingThisNickname = editingNicknameUserId === member.user_id;

                return (
                  <div
                    key={member.user_id}
                    className="rounded-xl bg-[#17212B] p-2.5 border border-[#242F3D] space-y-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2.5 min-w-0">
                        {/* Member Avatar */}
                        <div
                          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                            isMemberOwner
                              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                              : isMemberAdmin
                              ? 'bg-[#5288C1]/20 text-[#5288C1] border border-[#5288C1]/40'
                              : isMemberBanned
                              ? 'bg-red-500/20 text-red-400 border border-red-500/40'
                              : 'bg-[#242F3D] text-gray-300'
                          }`}
                        >
                          {memberInitial}
                        </div>

                        {/* Name & UUID */}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="truncate text-xs font-semibold text-white">
                              {member.nickname ? member.nickname : member.display_name}
                            </span>
                            {member.nickname && (
                              <span className="truncate text-[10px] text-[#7E90A3]">
                                ({member.display_name})
                              </span>
                            )}
                            {isMe && (
                              <span className="rounded bg-[#5288C1]/20 px-1 py-0.2 text-[9px] font-semibold text-[#5288C1]">
                                You
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-1 text-[10px] text-[#7E90A3] font-mono">
                            <span className="font-bold text-gray-300">ID: {toShortUserId(member.user_id)}</span>
                            <button
                              type="button"
                              onClick={() => copyMemberUuid(toShortUserId(member.user_id))}
                              className="text-[#5288C1] hover:underline"
                              title="Copy 8-Digit User ID"
                            >
                              {copiedMemberId === toShortUserId(member.user_id) ? (
                                <Check className="h-3 w-3 text-[#4ADE80]" />
                              ) : (
                                <Copy className="h-3 w-3" />
                              )}
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* Role Badge */}
                      <div className="shrink-0 flex items-center gap-1.5">
                        {isMemberOwner ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-300 border border-amber-500/30">
                            <Crown className="h-3 w-3" />
                            Owner
                          </span>
                        ) : isMemberAdmin ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-[#5288C1]/20 px-2 py-0.5 text-[10px] font-semibold text-[#5288C1] border border-[#5288C1]/30">
                            <Shield className="h-3 w-3" />
                            Admin
                          </span>
                        ) : isMemberBanned ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] font-semibold text-red-400 border border-red-500/30">
                            <Ban className="h-3 w-3" />
                            Banned
                          </span>
                        ) : (
                          <span className="rounded-full bg-[#242F3D] px-2 py-0.5 text-[10px] font-semibold text-[#7E90A3]">
                            Member
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Nickname Inline Editor */}
                    {isEditingThisNickname && (
                      <div className="flex items-center gap-1.5 pt-1.5 border-t border-[#242F3D] animate-in fade-in duration-150">
                        <input
                          type="text"
                          value={nicknameInput}
                          onChange={(e) => setNicknameInput(e.target.value)}
                          placeholder="Enter nickname or leave blank"
                          maxLength={50}
                          className="flex-1 rounded-lg bg-[#242F3D] px-2.5 py-1 text-xs text-white placeholder-[#7E90A3] outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => handleSaveNickname(member.user_id)}
                          disabled={isSavingNickname}
                          className="rounded-lg bg-[#5288C1] px-2.5 py-1 text-xs font-medium text-white hover:bg-[#4372a3] disabled:opacity-50"
                        >
                          {isSavingNickname ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingNicknameUserId(null)}
                          className="rounded-lg bg-[#242F3D] px-2 py-1 text-xs text-[#7E90A3] hover:text-white"
                        >
                          Cancel
                        </button>
                      </div>
                    )}

                    {/* Member Controls (Available for Admin/Owner or Self for Nickname) */}
                    <div className="flex items-center justify-between gap-1 pt-1 border-t border-[#242F3D]/60 text-[10px]">
                      {/* Edit Nickname Button */}
                      {(isAdminOrOwner || isMe) && !isEditingThisNickname && (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingNicknameUserId(member.user_id);
                            setNicknameInput(member.nickname || '');
                          }}
                          className="flex items-center gap-1 text-[#5288C1] hover:underline"
                        >
                          <Edit2 className="h-2.5 w-2.5" />
                          <span>{member.nickname ? 'Edit Nickname' : 'Set Nickname'}</span>
                        </button>
                      )}

                      <div className="ml-auto flex items-center gap-1.5">
                        {/* Owner granting/revoking Admin */}
                        {isOwnerUser && !isMemberOwner && !isMemberBanned && (
                          <button
                            type="button"
                            disabled={isActionLoading}
                            onClick={() => handleToggleAdmin(member.user_id, member.role)}
                            className={`rounded px-1.5 py-0.5 font-medium transition ${
                              isMemberAdmin
                                ? 'bg-[#242F3D] text-[#7E90A3] hover:text-white'
                                : 'bg-[#5288C1]/20 text-[#5288C1] hover:bg-[#5288C1]/30'
                            }`}
                          >
                            {isActionLoading ? (
                              <Loader2 className="h-2.5 w-2.5 animate-spin" />
                            ) : isMemberAdmin ? (
                              'Revoke Admin'
                            ) : (
                              'Give Admin'
                            )}
                          </button>
                        )}

                        {/* Ban / Unban Toggle (Owner or Admin, cannot ban owner or self) */}
                        {isAdminOrOwner && !isMemberOwner && !isMe && (
                          <button
                            type="button"
                            disabled={isActionLoading}
                            onClick={() => handleToggleBan(member.user_id, member.role)}
                            className={`rounded px-1.5 py-0.5 font-medium transition ${
                              isMemberBanned
                                ? 'bg-[#4ADE80]/20 text-[#4ADE80] hover:bg-[#4ADE80]/30'
                                : 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                            }`}
                          >
                            {isActionLoading ? (
                              <Loader2 className="h-2.5 w-2.5 animate-spin" />
                            ) : isMemberBanned ? (
                              'Unban'
                            ) : (
                              'Ban'
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* OWNER FEATURE: Password Rotation */}
        {isOwner && (
          <div className="rounded-2xl bg-[#0E1621] p-3.5 border border-[#242F3D] space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-white text-xs font-medium">
                <KeyRound className="h-3.5 w-3.5 text-[#5288C1]" />
                <span>Room Password</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowRotateForm(!showRotateForm);
                  clearError();
                }}
                className="text-[11px] font-medium text-[#5288C1] hover:underline"
              >
                {showRotateForm ? 'Cancel' : 'Rotate Password'}
              </button>
            </div>

            {showRotateForm && (
              <form onSubmit={handleRotatePassword} className="space-y-2.5 pt-2 border-t border-[#242F3D]/60 animate-in fade-in duration-200">
                <p className="text-[10px] text-[#7E90A3] leading-relaxed">
                  Rotating the password will re-wrap the room master key. All historical messages remain decryptable with the new password.
                </p>

                <div>
                  <label className="block text-[10px] text-[#7E90A3] uppercase font-semibold">Current Password</label>
                  <input
                    type="password"
                    value={oldPassword}
                    onChange={(e) => setOldPassword(e.target.value)}
                    placeholder="Enter current password"
                    required
                    className="mt-1 w-full rounded-xl bg-[#242F3D] px-3 py-1.5 text-xs text-white placeholder-[#7E90A3] outline-none"
                  />
                </div>

                <div>
                  <label className="block text-[10px] text-[#7E90A3] uppercase font-semibold">New Password</label>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Min 6 characters"
                    required
                    className="mt-1 w-full rounded-xl bg-[#242F3D] px-3 py-1.5 text-xs text-white placeholder-[#7E90A3] outline-none"
                  />
                </div>

                <div>
                  <label className="block text-[10px] text-[#7E90A3] uppercase font-semibold">Confirm New Password</label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter new password"
                    required
                    className="mt-1 w-full rounded-xl bg-[#242F3D] px-3 py-1.5 text-xs text-white placeholder-[#7E90A3] outline-none"
                  />
                </div>

                <button
                  type="submit"
                  disabled={isRotating || !oldPassword.trim() || newPassword.length < 6 || newPassword !== confirmPassword}
                  className="flex w-full items-center justify-center rounded-xl bg-[#5288C1] py-2 text-xs font-medium text-white transition hover:bg-[#4372a3] disabled:opacity-40"
                >
                  {isRotating ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm Password Rotation'}
                </button>
              </form>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="grid grid-cols-2 gap-2 pt-2 border-t border-[#242F3D]">
          <button
            onClick={() => {
              onClose();
              onLockNow();
            }}
            className="flex items-center justify-center gap-1.5 rounded-xl bg-[#242F3D] py-2.5 text-xs font-medium text-amber-400 hover:bg-[#2b3745] transition"
          >
            <Lock className="h-3.5 w-3.5" />
            <span>Lock Chat Now</span>
          </button>

          <button
            onClick={() => {
              onClose();
              router.push('/rooms');
            }}
            className="flex items-center justify-center gap-1.5 rounded-xl bg-[#242F3D] py-2.5 text-xs font-medium text-[#7E90A3] hover:text-red-400 transition"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span>Leave Room</span>
          </button>
        </div>
      </div>
    </div>
  );
}
