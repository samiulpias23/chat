# ChatAf — project rules (non-obvious only)

Specs: `docs/plan.md` (architecture + RLS acceptance tests), `supabase/schema.sql` (source of truth).
Keep both in sync; change schema → update plan §4 invariants.

## Stack / versions
- Next.js 16 App Router, React 19, Tailwind v4 (CSS-first, no tailwind.config), TypeScript strict.
- Next 16 renamed `middleware.ts` → `proxy.ts`. Never use it as the only auth gate.
- `@supabase/supabase-js` + `@supabase/ssr`. Hosting: Vercel Hobby. DB/Storage: Supabase Free.
- Scale: <50 users, <10 concurrent. Reject anything built for more (queues, caches, sharding).

## Secrets
- Never put keys/passwords in code, docs, or commits. Use `.env.local` + Vercel env.
- `SUPABASE_SECRET_KEY` only in `lib/supabase/admin.ts` (server-only, `import 'server-only'`), used by server routes.
- Web push: `VAPID_PRIVATE_KEY` is server-only. Notification text is fixed; never put message, sender or room name in it.
- `plan.txt` / `supabase_info.txt` hold leaked secrets: do not copy from them; rotate.

## E2EE invariants (`lib/crypto.ts`)
- Server never sees password, KEK, RMK, plaintext. Filenames/GIF URLs live inside ciphertext.
- One PBKDF2-SHA256 600k → HKDF → `kek` and `auth token` (separate `info`). Never PBKDF2 twice at different strengths.
- RMK imported/unwrapped as **non-extractable** AES-GCM. Extractable only at creation, to wrap.
- Fresh random 12-byte IV for EVERY encrypt (message, blob, key wrap). Never reuse/derive.
- AAD always set: `roomId|messageId[|slot]`; wrap uses `roomId`. Blob = `iv || ct+tag`.
- Password change re-wraps the SAME RMK (`rotate_room_password`); it does not revoke prior knowers.
- Forgot-password (owner email OTP) makes a NEW RMK and expires old messages; never claim history survives it.
- Unlock ALWAYS goes through `verify_room_password` (server rate limit). No local-only unlock.
- Reply quotes live inside the ciphertext payload. Reaction emoji are the one plaintext exception (server-visible, fixed allowlist of 6).
- Never write plaintext (text, media, ObjectURLs) to localStorage/sessionStorage/IDB/cookies.
  IndexedDB may hold **ciphertext only** (egress cache).

## AFK lock (`hooks/useAfkLock.ts`)
- Lock on `visibilitychange:hidden`, `pagehide`, bfcache `pageshow`, 15 s idle (deadline-based, re-checked on focus).
- `lock()` order: bump generation + abort in-flight → null RMK refs → revoke ALL object URLs from the central
  registry → clear React state/drafts → `removeChannel` → mount lock screen.
- Async decrypt/fetch must check the lock generation before setting state.
- Picker suspension has a hard 60 s timeout; never let it disable locking indefinitely.

## RLS / DB invariants
- Clients SELECT only. Every write is an RPC (SECURITY DEFINER + `set search_path`). No UPDATE/DELETE policies on messages/rooms/members/orders.
- `rooms` crypto columns (`kdf_salt, wrapped_room_key, wrapped_key_iv, auth_verifier_hash`) are not granted to clients.
- Anonymous users have role `authenticated`. `TO authenticated` is NOT an auth check; use `can_use_room()`.
- Liveness = `rooms.expires_at > now()` and `messages.expires_at > now()`. Never trust `status` (cron lags 24 h).
- Messages: 7 d hard ceiling, 24 h after `read_by_all_at`; enforced in RLS, set by trigger/RPC, never by client.
- `tx_hash` UNIQUE + lowercase-hex CHECK. Order amount computed server-side.
- Admin = JWT `app_metadata.role = 'admin'` (never email, never `user_metadata`). RPCs re-check `is_admin()`.
- Never rate-limit by client-supplied IP. Key on `auth.uid()` + room.
- New SECURITY DEFINER fn: revoke from public/anon, grant explicitly.
- Realtime channels are private, topic `room:<uuid>` (messages) and `room:<uuid>:live` (presence/typing; policy reads part 2 of the topic).

## Storage / media
- Bucket `chat-media` is private. Path `{roomId}/{messageId}/{raw|thumb}-{n}.enc`.
- Uploads go browser → Supabase directly (TUS for >6 MB). NEVER via a Next route/Server Action
  (Vercel 4.5 MB body cap; Server Actions 1 MB).
- Max 25 MB/blob, ≤10 per album. Thumbs: 160px WebP. Raw is untouched bytes, encrypted.
- Deleting media = Storage API `remove()`. Never SQL `DELETE FROM storage.objects`.
- Download-to-Delete: `delete_message_media` RPC first, then `remove()`.

## Cron (Vercel Hobby: 1 run/day, ±1 h)
- `GET /api/cron/cleanup`, verify `Bearer CRON_SECRET`, service-role client.
- Order: `list_purgeable_media` → Storage `remove()` (abort on error) → `purge_db`.
- Doubles as Supabase keep-alive (free projects pause after 7 idle days).

## Free-tier limits to respect
- DB 500 MB · Storage 1 GB · Egress 5 GB/mo · Realtime 200 conns.
- Egress trap: the 15 s lock wipes memory, so unlock must NOT re-download thumbnails → use the ciphertext IDB cache.
- No new paid-tier features, no extra services, no background workers.

## Admin
- `app/admin/layout.tsx`: `getUser()` (never `getSession()`), check `app_metadata.role`. Layout ≠ security boundary:
  re-check in every action/route handler.

## Style
- Don't add features outside docs/plan.md §7 "Keep". Cut list stays cut unless asked.
- Prefer deleting code to adding config. No comments restating code.
