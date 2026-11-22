# ChatAf Implementation Progress Tracker

Status Legend:
- `[ ]` Not started / In progress
- `[x]` Fully built, tested, and verified

---

## Milestone 1: Database Setup, Schema Migration & Anonymous Auth
- [x] Initialize Next.js 16 + React 19 + Tailwind v4 + TypeScript workspace & install dependencies
- [x] Database migration script to apply `supabase/schema.sql` to live Supabase DB (`scripts/migrate.mjs`)
- [x] Verify Supabase tables, RLS policies, stored procedures, and `chat-media` storage bucket
- [x] Seed admin account `admin@chataf.com` with `app_metadata.role = 'admin'`
- [x] Implement Supabase client libraries (`lib/supabase/client.ts`, `server.ts`, `admin.ts`)
- [ ] **Blocker (dashboard):** enable Supabase → Authentication → Sign In / Providers → "Allow anonymous sign-ins" (currently disabled; app shows a red banner until fixed)
- [x] Implement silent Anonymous Auth bootstrap (`signInAnonymously`) & initial profile auto-creation (`components/auth/AuthProvider.tsx`)
- [x] Run automated RLS acceptance tests on live Supabase (`scripts/test-rls.mjs`: 12/12 passed)

---

## Milestone 2: Web Crypto E2EE Engine & Instant Background/AFK Lock
- [x] Implement `lib/crypto.ts` (PBKDF2 600k, HKDF split to KEK & authTok, non-extractable RMK, AES-256-GCM with unique 12B IV & AAD binding)
- [x] Implement `lib/cipherCache.ts` (IndexedDB ciphertext cache for thumbnails and raw media)
- [x] Implement `lib/urlRegistry.ts` (Central object URL registry for instant atomic memory revocation)
- [x] Implement `hooks/useAfkLock.ts` (0ms lock on app switch/minimize/tab change, 15s deadline-based idle countdown, 60s picker timeout)
- [x] Implement `<RoomLockScreen />` (Rate-limited unlock via `verify_room_password`, RMK unwrap into volatile React ref)
- [x] Unit test cryptographic operations (`scripts/test-crypto.mjs`: 10/10 passed)

---

## Milestone 3: Telegram-Inspired Chat UI, Viewport & Search Directory
- [x] Configure Dark Matte Blue palette in `app/globals.css`
- [x] Implement `hooks/useViewportHeight.ts` (`100dvh` + `window.visualViewport` for Android Chrome virtual keyboard)
- [x] Implement 2-tab bottom navigation (`Rooms` · `Profile`) with auto-hide in active chat
- [x] Build Rooms directory page (`/rooms`) with real-time room search bar and live status badges
- [x] Build Profile page (`/profile`) with display name editor and UUID copy
- [x] Build full-screen Chat UI (`/chat/[roomId]`): `ChatHeader`, `MessageList`, `MessageBubble`, `MessageComposer`

---

## Milestone 4: Messages, Dynamic Read Quorum, GIPHY & Direct-to-Storage Upload
- [x] Implement `hooks/useRealtimeChat.ts` (Private channels `room:<roomId>`, real-time message stream)
- [x] Implement `hooks/useRoomReadReceipt.ts` (Calls `mark_room_read` RPC on room view and new message receipt)
- [x] Implement GIPHY proxy route (`/api/gif/search`) and GIF picker component (`GiphyPicker.tsx`)
- [x] Implement direct-to-storage upload pipeline (160px canvas WebP thumbnail + raw lossless `.enc`, direct browser $\rightarrow$ Supabase)
- [x] Connect `cipherCache` for zero-egress thumbnail rendering upon unlock

---

## Milestone 5: Multi-Image Album Mosaic, Full-Screen Gallery & Download-to-Delete
- [x] Build `MultiImageMosaic` component (up to 10 photos, individual download indicators, "Download All" batch button)
- [x] Build full-screen `RawGalleryModal` (pinch-to-zoom, pan, swipe navigation, raw 4K display)
- [x] Implement Download-to-Delete flow (`delete_message_media` RPC flag $\rightarrow$ Storage `remove()` $\rightarrow$ local IDB persistence for downloader)

---

## Milestone 6: Room Orders, Admin Panel, 24h Cron Cleanup & Hardening
- [x] Implement "+ Add Room" flow with account email linking check (`create_room` RPC)
- [x] Implement BSC BEP20 $1/month payment page with lowercase-hex TxID submission (`submit_order` RPC)
- [x] Build `/admin/login` and `/admin` dashboard gated server-side by `app_metadata.role === 'admin'`
- [x] Implement `/api/cron/cleanup` route (`CRON_SECRET` bearer auth, `list_purgeable_media` $\rightarrow$ Storage `remove()` $\rightarrow$ `purge_db` RPC)
- [x] Production build verification (`npm run build`: 10/10 routes compiled with 0 errors)
