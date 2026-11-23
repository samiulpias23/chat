# ChatAf — E2EE Ephemeral Chat: Architecture & Plan (v1.3.0, post-audit)

Stack: Next.js 16 (App Router) · Tailwind v4 · Supabase Free (Mumbai) · Vercel Hobby.
Scale: <50 total users, <10 concurrent. Schema of record: `supabase/schema.sql`.
Supersedes `plan.txt` (v1.2.0). **No secrets in this file** — see §1.3.

## 0. Audit changelog (what v1.2.0 got wrong)

| # | Severity | Flaw in v1.2.0 | Fix in v1.3.0 |
|---|---|---|---|
| 1 | Critical | `approve_room_order` was SECURITY DEFINER with no admin check → anyone could approve their own order | `is_admin()` check inside RPC; admin = `app_metadata.role='admin'` |
| 2 | Critical | Owner `UPDATE` policy on `rooms` let owners set `status='active'`/`expires_at` themselves (free rooms) | No client write policy on `rooms`; `create_room`/`setup_room_e2ee` RPCs only |
| 3 | Critical | `room_orders` INSERT policy let users insert `status='approved'` | No insert policy; `submit_order` RPC forces `pending`, amount = months × $1 |
| 4 | Critical | `room_members` INSERT/UPDATE open: anyone could join any room w/o password, or set `role='owner'` | No client writes on `room_members`; join only via `verify_room_password` |
| 5 | Critical | `rooms` SELECT `true` exposed `wrapped_room_key`, salts, bcrypt hash to every user → offline brute force, no rate limit | Column-level grants hide crypto columns; wrapped key released only after verified password |
| 6 | High | `room_members` SELECT policy queried itself → infinite recursion | `is_room_member()` SECURITY DEFINER helper |
| 7 | High | `messages` UPDATE policy only checked `media_deleted=true`: could rewrite ciphertext/`expires_at` | No UPDATE policy; `delete_message_media` RPC |
| 8 | High | Client could insert own `expires_at`/`read_by_all_at` | BEFORE INSERT trigger forces server values |
| 9 | High | Rate limit keyed on client-supplied IP (spoofable), table had no RLS | Keyed on `auth.uid()` + room-wide cap; RLS on, no policies |
| 10 | High | `mark_room_read` let non-members stamp any room's messages | Requires `can_use_room` |
| 11 | High | Read quorum never completed: sender's own `last_read_at` < their message | `AFTER INSERT` trigger stamps sender |
| 12 | High | No Storage policies defined at all; no expiry check at Storage level | Path-based policies requiring live room + member + unexpired message |
| 13 | High | Auth token at 100k PBKDF2 was the weak link (DB leak → password) | One 600k PBKDF2 → HKDF split into KEK / auth token |
| 14 | High | Lock-screen unlock was local-only → unlimited offline guessing by whoever holds the phone | Unlock goes through the rate-limited RPC every time |
| 15 | High | Every lock wipes thumbnails → every unlock re-downloads them: ~10 GB/mo egress vs 5 GB cap | Cache **ciphertext** in IndexedDB (§3.3) |
| 16 | Med | `tx_hash` UNIQUE bypassable via `0xAB…` vs `0xab…` | CHECK lowercase-hex-66 + lowercased in RPC |
| 17 | Med | No `search_path` on SECURITY DEFINER fns; default EXECUTE to `anon` | `set search_path`, revoke from public/anon |
| 18 | Med | Realtime channel open to anyone who knows a room UUID (directory leaks them) | Private channels + `realtime.messages` RLS |
| 19 | Med | Admin password + all Supabase keys written into plan; admin gated by email string | Removed; role claim in `app_metadata`; **rotate** (§1.3) |
| 20 | Med | Renewal of a never-set-up room flipped it to `active` with no key | Status derived from `wrapped_room_key IS NULL` |
| 21 | Low | Expiry relied on `status` flipped by daily cron (24h lag) | All policies use `expires_at > now()` |

## 1. Principles

1. Server is zero-knowledge: never sees RMK, password, plaintext. Storage holds `.enc` blobs only.
2. Guests are Supabase anonymous users (role `authenticated`!). Room **creation** requires a non-anonymous user (`create_room` checks `is_anonymous`); link an email via `updateUser` so ownership/payment survives cleared browser data.
3. Secrets live only in JS memory (non-extractable `CryptoKey`). Never `localStorage`/cookies/plaintext IDB.
4. Mutations only through RPCs; clients only SELECT. Every policy checks `expires_at > now()`, never `status` alone.

### 1.2 What is stored on the phone
- `localStorage`: `displayName`, `lastRoomId` (<1 KB).
- IndexedDB: **ciphertext only** (thumb blobs; raw blobs the user downloaded) — useless without the RMK. No plaintext media at rest. "Download" = browser saves the decrypted file to the user's device (their explicit choice).
- Dropped from v1.2: plaintext IDB LRU cache of raw photos (contradicted the threat model, duplicated the device download).

### 1.3 Secrets handling
`plan.txt` and `supabase_info.txt` contain live DB password, service-role/secret keys and the admin password. They are not repeated here.
- Put keys in `.env.local` (gitignored) and Vercel env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` (server only, cron), `CRON_SECRET`, `GIPHY_API_KEY`.
- Rotate the DB password, secret key and admin password before launch (they have been pasted into chat/text files). Delete both txt files.
- Dashboard: Auth → enable Anonymous sign-ins; keep Email provider (owners). Set admin via `raw_app_meta_data` (see end of schema.sql).

## 2. Flows

### 2.1 Key hierarchy (`lib/crypto.ts`)
```
master  = PBKDF2-SHA256(password, kdf_salt[16B], 600_000)          // once per unlock
KEK     = HKDF(master, info="chataf-kek")   -> AES-GCM 256, non-extractable, wrap/unwrap only
authTok = HKDF(master, info="chataf-auth")  -> base64, sent to RPC; server stores bcrypt(authTok)
RMK     = random AES-GCM 256 (extractable ONLY at creation, to wrap)
wrapped = AES-GCM(KEK, iv12, RMK_raw, aad = roomId)
```
Create: client makes salt+RMK → `setup_room_e2ee`. Join/unlock: `get_room_kdf_salt` → derive → `verify_room_password` (rate-limited; returns wrapped key only on success) → `unwrapKey(..., extractable:false)`.

### 2.2 Encryption rules
- Every encryption uses a **fresh `crypto.getRandomValues(12B)` IV**; never reuse, never derive from a counter on a second device. Random 96-bit IV is safe for this volume.
- AAD binds ciphertext to context: messages `aad = roomId|messageId`; blobs `aad = roomId|messageId|slot`. Prevents moving ciphertext between rooms/messages.
- Message `encrypted_content` is JSON `{text, fileNames[], gifUrl}` — filenames and GIF URLs are inside the ciphertext. Plaintext metadata the server sees: `media_type`, `media_count`, sizes, timing (accepted).
- Blob format: `iv(12B) || ciphertext||tag`.
- Cap raw uploads at 25 MB client-side (one-shot Web Crypto holds the file in RAM); bucket limit 26 MB.

### 2.3 Password change (rotation)
- `rotate_room_password` (owner only, needs **old** auth token): new salt, new IV, re-wrap the **same RMK**, new bcrypt. Atomic, row-locked.
- Forgotten password: `/api/rooms/forgot-password` emails a Supabase OTP to the owner's account email (masked in the response). `/api/rooms/reset-password` verifies it server-side, max 5 wrong codes per user+room per 10 min, then calls `reset_room_password_by_owner` (service_role only). The client makes a **new** RMK, since the old one is unrecoverable, so the RPC expires all existing messages (cron purges the blobs). Needs the Supabase "Magic Link" email template to include `{{ .Token }}`.
- Consequence (document in UI): this does **not** revoke someone who already knew the old password or captured the RMK. True revocation = new RMK, which makes ≤7-day-old history unreadable. Not built (YAGNI for <50 users); if a member must be removed, create a new room.
- After rotation other members' next unlock simply needs the new password; their session is unaffected.

### 2.4 Media pipeline (free-tier critical)
- Browser → Supabase Storage **directly** with the user's JWT (`supabase.storage.upload`, TUS resumable for files > 6 MB to `https://<ref>.storage.supabase.co/storage/v1/upload/resumable`). **Never** through a Next.js route or Server Action (Vercel body limit 4.5 MB; Server Actions 1 MB).
- Path: `{roomId}/{messageId}/{raw|thumb}-{n}.enc` (n 0–9, max 10 per album). Client generates `messageId` (uuid), uploads blobs, **then** inserts the message row. Failed sends are cleaned by uploader (storage policy allows own-object delete) or the cron.
- Thumb: 160px WebP via canvas (<15 KB, also strips EXIF). Raw: untouched bytes, encrypted.
- GIFs: URL only inside ciphertext; `/api/gif/search` proxies GIPHY (key stays server-side). Allow only `https://media*.giphy.com/` URLs when rendering.

### 2.5 Download-to-Delete
1. Client downloads + decrypts raw → saves file to device.
2. `rpc('delete_message_media', id)` — member of live room; sets `media_deleted=true`.
3. Client `supabase.storage.from('chat-media').remove(paths)` — storage DELETE policy only passes when step 2 flagged the message (or caller is the uploader).
4. Others see "media deleted" placeholder. Deleting is per message (whole album).
SQL `DELETE` on `storage.objects` is never used (leaves orphan files, doesn't free quota).

### 2.6 Read-receipt expiry
Hard ceiling 7 days (`expires_at` default). When every member active in the last 7 days has `last_read_at >= created_at`, `mark_room_read` sets `expires_at = least(now()+24h, created_at+7d)`. Call it on room unlock and when a new message is rendered while unlocked. RLS also rejects rows older than 7d or 24h past `read_by_all_at`.

## 3. Free-tier budget

### 3.1 DB
~2,100 live rows × ~0.6 KB ≈ 1.3 MB. Irrelevant vs 500 MB.

### 3.2 Storage (1 GB)
105 raw photos in worst-case 7-day window × ~4 MB ≈ 420 MB. Download-to-Delete + 24h-after-read expiry keep it far lower. Daily cron prunes.

### 3.3 Egress (5 GB/mo) — corrected
v1.2 forgot that the 15 s lock wipes memory, so every unlock re-fetches thumbnails. 10 users × ~20 unlocks/day × ~105 thumbs × 15 KB ≈ 315 MB/day ≈ 9.4 GB/mo (**over cap**).
Fix: IndexedDB `ciphertext` cache keyed by object path (thumbs always; raw only after user opens it, LRU 100 MB). Unlock then = 1 messages query + 1 RPC, ~0 media egress. Expected: ~2 GB/mo. Purge cache entries for messages no longer returned by the DB.

### 3.4 Realtime
10 connections of 200. One private channel per open room. Presence/typing is optional (§7).

## 4. Database
See `supabase/schema.sql`. Invariants to keep when editing it:
- Clients: SELECT only (+ own `profiles` upsert). `rooms` crypto columns not granted.
- `tx_hash`: UNIQUE + `^0x[0-9a-f]{64}$`.
- Admin = JWT `app_metadata.role = 'admin'` (service-role-writable only). Never email string, never `user_metadata`.
- Anonymous users have role `authenticated` → "TO authenticated" is not an auth boundary; use `can_use_room()`.

## 5. AFK / background lock (`hooks/useAfkLock.ts`)

Triggers → `lock()`:
- `visibilitychange` (hidden), `pagehide`: immediate. `pageshow` with `persisted` (bfcache): force locked.
- `blur`: desktop only; ignored on touch devices (fires spuriously with IMEs/dialogs).
- 15 s idle: reset on `pointerdown/keydown/input/touchstart/scroll`. Use `performance.now()` deadline + `setTimeout`, and **re-check the deadline on every visible/focus event** (mobile throttles background timers). Realtime messages never reset it.
- Picker suspension (`isSelectingMediaRef`): set on tap of Photo/Camera; cleared on `change`, `cancel` event, window `focus`, **or a hard 60 s timeout** (cancelled pickers on some Androids fire nothing → lock would otherwise be disabled forever).

`lock()` must, in this order, synchronously:
1. Bump `lockGeneration` and `abortController.abort()` — in-flight fetch/decrypt must check the generation before touching state (otherwise a late decrypt repopulates plaintext after the wipe).
2. `rmkRef.current = null`; drop any wrapped-key/KEK/derived refs.
3. Revoke **every** object URL from a central registry `Set` (not just those in React state); `registry.clear()`; null canvases/ImageBitmaps; `img.src=''` for rendered media.
4. `setMessages([])`, clear composer draft, GIF results, gallery modal, search text.
5. `supabase.removeChannel(channel)` (not just `untrack`) so nothing keeps streaming.
6. Clear the password input; mount `<RoomLockScreen />`.
JS can't zero memory; the goal is "no live references". Don't claim more in UI copy.

Unlock = PBKDF2 600k (~0.3–1 s on phones; show spinner) + `verify_room_password`. Failed-attempt UX: surface `rate_limited` as "Too many tries, wait a minute".

## 6. Cron (`app/api/cron/cleanup/route.ts`, `vercel.json`: `0 3 * * *`)
Hobby = max **one run/day**, timing ±1 h. Route is `GET`, must verify `Authorization: Bearer ${CRON_SECRET}` (Vercel sends it automatically) and use the service-role client (`lib/supabase/admin.ts`, server-only).
Order matters:
1. `paths = rpc('list_purgeable_media', {p_limit: 500})` (expired/deleted/orphaned/expired-room objects).
2. `storage.from('chat-media').remove(paths)` in chunks of 100 — **Storage API, not SQL**. If it errors, stop (rows still point at the files; retry tomorrow).
3. `rpc('purge_db')` — deletes expired messages, flips `active→expired`, trims attempts.
Because RLS/Storage policies already hide expired data, the 24 h cron lag is a cost issue, not a security issue. The daily DB hit also prevents free-tier 7-day inactivity pause.

## 7. UI scope (cut for <10 live users)
Keep: Telegram-dark palette, `100dvh` + `visualViewport`, room search (client-side `includes` filter — no trigram index), 2-tab bottom nav (Rooms · Profile), mosaic ≤10 photos, Download All.
Cut/defer: avatar & room-photo uploads (initial-letter circles instead), `room_nickname`, `admin` member role, `user_code`, `order_type`, wallet/network columns, `updated_at` triggers, `uuid-ossp`/`pg_trgm`, plaintext IDB LRU, 3rd "active chat" nav tab. Presence dock + typing indicator = last milestone, optional.

## 8. Payments & admin
- $1/month, months ∈ {1,2,3,6,12,24}; `amount_usd` is computed server-side. Wallet address lives in `NEXT_PUBLIC_PAY_ADDRESS` env, not in code. Verify the on-chain tx manually via BscScan.
- A rejected order's `tx_hash` stays burned (UNIQUE) — intended.
- `/admin`: `app/admin/layout.tsx` uses `supabase.auth.getUser()` (validates JWT with Auth server; never `getSession()`), checks `user.app_metadata.role === 'admin'`, else `redirect('/admin/login')`. A layout is not a security boundary for Server Actions/route handlers: every admin action re-checks, and the DB RPCs re-check `is_admin()` regardless. Don't rely on `proxy.ts` (Next 16 middleware rename) as the only gate. `/admin/login` is the only unguarded admin route; rate-limit by Supabase Auth defaults.
- Lifecycle: `pending_payment → (approve) unlocked_setup → (setup_room_e2ee) active → (cron) expired → (approve renewal) active`.

## 9. Structure (trimmed)
```
app/{(chat)/rooms,(chat)/chat/[roomId],(chat)/profile,admin/{login,layout,page},api/{cron/cleanup,gif/search}}
components/{chat,rooms,navigation}   hooks/{useAfkLock,useRealtimeChat,useViewportHeight,useCipherCache,useRoomReadReceipt}
lib/{crypto.ts,cipherCache.ts,imageCompression.ts,tusUpload.ts,supabase/{client,server,admin}.ts}
supabase/schema.sql   vercel.json   .env.local (gitignored)
```

## 10. Milestones
1. Schema + anonymous auth + profile. Test RLS with two users (member / non-member / expired room).
2. `crypto.ts` + `useAfkLock` + unlock RPC flow (unit-test wrap/unwrap, AAD mismatch, rotation).
3. Chat UI, room directory, viewport handling.
4. Messages, read receipts, GIPHY, direct-to-storage upload + ciphertext cache.
5. Mosaic, raw viewer, Download-to-Delete.
6. Orders, `/admin`, cron, rotate all secrets, deploy.

### RLS acceptance tests (must pass before launch)
- Non-member: cannot SELECT messages/roster, cannot read storage object, cannot subscribe to `room:<id>`, cannot read `rooms.wrapped_room_key`.
- Member of room with `expires_at <= now()` (status still `active`): SELECT/INSERT messages and Storage SELECT/INSERT all denied.
- Message with `read_by_all_at` 25 h ago: not returned though `expires_at` is in the future.
- Client insert with forged `expires_at`/`read_by_all_at`: overwritten by trigger.
- Non-admin calls `approve_room_order`: error. Duplicate/upper-case `tx_hash`: rejected.
- Direct `PATCH rooms`/`room_members`/`messages`: denied.
- Storage `remove()` before `delete_message_media`: denied; after: succeeds.
