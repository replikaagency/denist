# Changelog

## [Unreleased]

### Changed

- **Turn-limit escalation uses shared constant** (`src/lib/conversation/engine.ts`): Rule 5 now compares `state.turn_count` to `LIMITS.MAX_TURNS_BEFORE_ESCALATION` from `config/constants.ts` instead of a hardcoded `20`, so tuning the limit is single-sourced.

### Added

- **Pilot monitoring checklist** (`docs/PILOT_MONITORING.md`): What to watch during deployment (500s on `/api/chat`, handoff types, double-tab / concurrent request caveat).
- **Staff doc: contact merge** (`docs/STAFF_CONTACT_MERGE.md`): Explains that duplicate phone/email relinks to the canonical contact and does not overwrite existing name fields on that record.

## [1.1.0] — 2026-03-18

### Added

- **Robust rescheduling flow** (`supabase/migrations/0006_reschedule_support.sql`, `src/lib/db/appointments.ts`, `src/services/appointment.service.ts`, `src/services/chat.service.ts`): Atomic cancel-old + create-new via a Postgres RPC so the dedup index is never violated. Sub-flow: intent=`appointment_reschedule` triggers `findOpenRequestsForContact` → 0 results redirects to new booking, 1 auto-selects, 2+ shows numbered list (`selecting_target` phase, LLM bypassed, handled in step 6.7). Once target is locked (`collecting_new_details`), normal LLM turns fill new date/time/service. When data is complete `isRescheduleReady` enters the confirmation flow (Feature 1) showing old→new summary. On `yes`, `executeReschedule()` calls the RPC; if the old request was already closed by staff it falls back gracefully to `createRequest()`. On `no`, old appointment is untouched. `ConversationState` gains `reschedule_target_id`, `reschedule_target_summary`, `reschedule_phase` — all `.default()`-safe. DB types updated with `rescheduled_from`, `rescheduled_to`, `cancelled_at`, `cancel_reason`.

## [1.0.0] — 2026-03-18

### Added

- **Explicit appointment confirmation flow** (`lib/conversation/schema.ts`, `services/chat.service.ts`): No appointment row is written to the DB until the patient explicitly confirms with "sí". When all required fields are collected the system now: (1) stores the appointment snapshot in `ConversationState.pending_appointment`, (2) sets `awaiting_confirmation=true`, (3) overrides the LLM reply with a structured confirmation summary. On the next turn the LLM is bypassed and `classifyConfirmation()` decides the branch: confirmed → `createRequest()` + clear state; declined → clear state + invite changes; ambiguous (×2) → escalate to human. `ConversationState` gains three new fields: `awaiting_confirmation`, `pending_appointment`, `confirmation_attempts` — all with `.default()` so existing DB records parse without a migration.

## [0.9.1] — 2026-03-18

### Fixed

- **`fields.ts` prompts Spanish-ized** (`lib/conversation/fields.ts`): All `COMMON_PROMPTS` and the `post_treatment_concern` override were English and reached patients via `correctedReply` when the flow controller overrode the LLM. All 16 prompts + the fallback string are now natural Spanish (Spain). TypeScript: clean.

- **Spanish service names now resolve correctly** (`services/appointment.service.ts`): `SERVICE_TYPE_TO_APPOINTMENT_TYPE` extended with ~60 Spanish variants covering new patient, cleaning/checkup, emergency, whitening, implants, orthodontics, and common other treatments. `resolveAppointmentType('limpieza dental')` now returns `'checkup'` instead of `'other'`. English entries preserved.

- **`completed=true` flow-locking bug** (`lib/conversation/engine.ts`): The backstop that sets `completed=true` now only fires for scheduling intents (`appointment_request`, `appointment_reschedule`). Previously, intents with no `FIELD_REQUIREMENTS` entry (e.g. `gratitude`, `clinic_info`) would have `getMissingFields()` return `[]` and incorrectly set `completed=true`, permanently locking the conversation into `terminal` stage.

- **Notes unbounded growth** (`services/appointment.service.ts`): The `buildEnrichPatch` notes-fallback merge now uses `!existing.notes.includes('Patient preferred')` as its deduplication guard instead of an exact string match. This prevents accumulation of multiple fallback entries when the patient mentions different unparseable date/time values across turns — the first fallback written is preserved; subsequent turns do not append.

## [0.9.0] — 2026-03-18

### Added

- **Full Spanish localization** (`lib/conversation/prompts.ts`, `lib/conversation/engine.ts`, `config/constants.ts`): All system prompt layers, few-shot examples, fallback replies, escalation appends, and the AI greeting are now in Spanish (Spain, tú form). Fallback 5 detection extended with Spanish phrases ("déjame comprobar", "miro la disponibilidad", etc.). Pricing regex now strips both `$` and `€` amounts.

- **Almería clinic config** (`lib/conversation/prompts.ts`): `DEFAULT_CLINIC_CONFIG` updated to Clínica Dental Sonrisa Almería with Spanish insurance providers, services, and providers. `ClinicConfig` extended with optional `timezone`, `appointment_duration`, `language` fields; env-var overrides added (`CLINIC_TIMEZONE`, `CLINIC_APPOINTMENT_DURATION`, `CLINIC_LANGUAGE`).

### Fixed

- **LLM parse failure no longer orphans the patient message** (`services/chat.service.ts`): If `processTurn` returns a parse error the service now inserts a fallback AI message ("Lo siento, no te he entendido bien…") and returns early instead of throwing, so the already-persisted patient message is never left without a reply. `ChatTurnResult.turnResult` is now `TurnResult | null`.

- **`enrichContact` null no longer silently discarded** (`services/chat.service.ts`): When `enrichContact` returns `null` (duplicate phone/email detected) a `console.warn` is now emitted with `conversation_id` and `contact_id`.

- **Race recovery failure now logged** (`services/appointment.service.ts`): If the post-constraint-violation re-query in `createRequest` still finds no winner, `console.error` is emitted before re-throwing.

- **Redundant `getConversationById` eliminated** (`services/conversation.service.ts`, `services/chat.service.ts`): `saveState` now returns the updated `Conversation` (from `updateConversation`), removing the extra DB read that previously followed every turn.

- **`ensureLead` called at most once per turn** (`services/chat.service.ts`): `lead` is hoisted before the identity block and reused in the appointment block, eliminating the duplicate `ensureLead` call on turns that fire both.

### Observability

- **Structured logs added** (`services/chat.service.ts`, `services/appointment.service.ts`):
  - `[ChatService] correction_applied` — when `is_correction=true` after `processTurn`
  - `[ChatService] unexpected_flow` — when `flowValidation.overridden=true`
  - `[AppointmentService] appointment_created` — on new appointment row
  - `[AppointmentService] appointment_updated` — on enrichment of existing row (both normal and race-recovery paths)

## [0.8.8] — 2026-03-17

### Fixed

- **Patient realtime RLS tightened to session_token** (`supabase/migrations/0004_rls_patient_realtime.sql`, `app/api/chat/realtime-token/route.ts`, `hooks/use-realtime.ts`, `components/chat/chat-ui.tsx`): The anon SELECT policy on `messages` previously only checked that the conversation UUID existed — any anon who knew a valid UUID could read those messages. Now:
  1. Anon must present a JWT with `session_token` claim (from `POST /api/chat/realtime-token`).
  2. RLS policy `anon_read_own_messages` uses `anon_owns_conversation()` to verify the JWT's `session_token` matches the contact linked to the conversation.
  3. `messages` and `conversations` are idempotently added to `supabase_realtime` publication (fixes projects that never ran the idempotent schema).
  4. Chat widget fetches the realtime token after `POST /api/chat/start` and passes it to `useRealtimeMessages`; `supabase.realtime.setAuth(token)` is called before subscribing.
  5. Requires `SUPABASE_JWT_SECRET` in env (Project Settings > API > JWT Secret). If missing, realtime-token returns 503 and patient chat works without live updates.

## [0.8.7] — 2026-03-17

### Fixed

- **Appointment confirmation response flow** (`lib/conversation/prompts.ts`, `lib/conversation/engine.ts`, `services/chat.service.ts`): After the patient confirmed a preference (e.g. "a las 8"), the AI would say "let me check" or "I'll get back to you" and the conversation felt incomplete. Now: (1) prompt instructs a clear final confirmation (request registered, preference noted, staff will confirm); (2) few-shot `appointment_completion` example injected when all fields collected; (3) engine fallback rewrites replies that still contain misleading phrases.

## [0.8.6] — 2026-03-17

### Fixed

- **Patient scheduling preferences no longer silently lost** (`services/appointment.service.ts`): Time phrases like "a las 8", "at 8", "8:00", and "17:30" that could not be normalized to `preferred_time_of_day` were dropped. Now: (1) `normalizeTimeOfDay` recognizes bare hours and "a las X" / "at X" patterns (6–11 → morning, 12–16 → afternoon, 17–23 → evening) and 24h format; (2) when normalization still fails, the raw text is preserved in `notes` as "Patient preferred time: …" and "Patient preferred date: …"; (3) enrichment merges new fallback text into existing notes instead of overwriting.

## [0.8.5] — 2026-03-17

### Fixed

- **Appointment request cannot be confirmed without `confirmed_datetime`** (`app/api/appointment-requests/[id]/route.ts`, `app/dashboard/appointments/appointments-list.tsx`): Staff could previously click "Confirm" and set `status = confirmed` without providing the actual booked slot, leaving `confirmed_datetime` null. The API now rejects `status: confirmed` when `confirmed_datetime` is missing. The dashboard Confirm button opens a dialog that collects the booked date/time before confirming.

## [0.8.4] — 2026-03-17

### Fixed

- **`POST /api/conversations/[id]/handoff` — closed-status check now runs before idempotency check** (`app/api/conversations/[id]/handoff/route.ts`): A conversation that was `resolved` or `abandoned` while still having a stale unresolved `handoff_event` row would return `200` with the open handoff instead of `409 CONFLICT`. Moved the closed-status guard ahead of the open-handoff idempotency check.

- **`PATCH /api/conversations/[id]` — `abandoned` now forces `ai_enabled: false`** (`app/api/conversations/[id]/route.ts`): Only `resolved` was forcing the flag off; `abandoned` was not, leaving conversations in an inconsistent state. Both closing statuses now consistently disable AI.

- **`appointment.service.ts` — `advanceLeadStatus` no longer downgrades a `booked` lead** (`services/appointment.service.ts`): When a confirmed appointment was cancelled and the patient reopened the same conversation, `createRequest` would create a new appointment row and unconditionally call `advanceLeadStatus(contactId, 'appointment_requested')`, regressing a `booked` lead. A status-rank guard now skips the advance when the lead is already at `booked`, `lost`, or `disqualified`.

## [0.8.3] — 2026-03-17

### Fixed

- **Trailing space in `OPENAI_MODEL`** (`.env.local`): `gpt-4.1 ` had a trailing whitespace character that could cause an "invalid model" error with stricter dotenv loaders. Trimmed to `gpt-4.1`.
- **`eslint-config-next` version mismatch** (`package.json`): Pin was `15.0.3` while `next` had moved to `^16.1.6`. Aligned to `^16.1.6` to prevent peer-dep warnings and potential lint rule drift.

## [0.8.2] — 2026-03-17

### Fixed

- **Appointment request enriched on subsequent triggers** (`services/appointment.service.ts`, `lib/db/appointments.ts`): When `confirm_details` fired early (before the patient had provided `service_type`, date, or time), the appointment row was created with `appointment_type = 'other'` and null scheduling fields. Subsequent triggers — including `offer_appointment` once all fields were collected — immediately returned the stale row unchanged via the idempotency guard, permanently locking in the incomplete data.

  **Fix:** `createRequest` now resolves all normalised field values upfront (`resolveFields`), and if an open request already exists, calls `buildEnrichPatch` to compute a diff. Any field that is null/degraded in the existing row and non-null/improved in the current turn is written via the new `enrichAppointmentRequest` DB function. Rules:
  - `appointment_type` is upgraded from `'other'` only — never overwrites a specific type with a different specific type.
  - `preferred_date`, `preferred_time_of_day`, and `notes` are filled if currently null.
  - The same enrichment is applied to the race-condition winner so the re-query path also benefits.

  Added `enrichAppointmentRequest` to `lib/db/appointments.ts` — a restricted update that only accepts scheduling fields (not status) to prevent accidental lifecycle transitions via this path.

## [0.8.1] — 2026-03-17

### Fixed

- **Appointment capture now robust across all LLM next_action paths** (`services/chat.service.ts`): The appointment request row was only created when the LLM returned `next_action: "offer_appointment"`. The system prompt explicitly permits `"confirm_details"` as an equally valid completion action for scheduling intents, and the conversation engine independently sets `state.completed = true` when all required fields are collected but the LLM used the wrong action. Both signals were previously ignored — the appointment row was silently never created in those cases.

  **Fix:** Three independent triggers now fire `createRequest`, any one of which is sufficient:
  1. `next_action === 'offer_appointment'` — canonical path (unchanged).
  2. `next_action === 'confirm_details'` when `current_intent` is `appointment_request` or `appointment_reschedule` — creates the row before the patient can drop off between confirmation and slot-offering turns.
  3. `state.completed === true` when `current_intent` is a scheduling intent — defensive backstop for LLM output errors where all fields are collected but the action is wrong.

  `createRequest` is idempotent (app-level early-return + DB partial unique index) so multiple triggers on consecutive turns produce exactly one row.

- **Appointment capture race condition now handled gracefully** (`services/appointment.service.ts`): A concurrent pair of requests for the same `conversationId` that both pass the app-level duplicate check before either completes the insert would previously cause the second request to throw an unhandled `AppError.database` and crash the entire chat turn with a 500. Added a try/catch around `createAppointmentRequest`; on any error the function re-queries for an open request — if a race winner exists it is returned silently; if not, the original error is re-thrown.

- **`isSending` guard on "New chat" reset** (`components/chat/chat-ui.tsx`): Clicking "Confirm?" while a `sendMessage` was in-flight would wipe all state and then have the in-flight callback append the AI response to the freshly cleared new conversation. Added `if (isTyping) return` at the top of the confirmed branch.

- **`confirmTimerRef` cleanup on unmount** (`components/chat/chat-ui.tsx`): The 3-second confirmation auto-cancel timer was never cleared if the component unmounted. Added a `useEffect` cleanup.

## [0.8.0] — 2026-03-17

### Fixed

- **Patient realtime blocked by missing anon RLS policy** (`supabase/migrations/0003_anon_messages_rls.sql`, `0001_initial_schema_idempotent.sql`): The `messages` table had RLS enabled with only a `TO authenticated` SELECT policy. Unauthenticated (anon) patients subscribing via `useRealtimeMessages` received no events — staff replies, takeover notifications, and resolve messages never appeared without a page refresh.

  **Root cause:** Supabase Realtime `postgres_changes` respects RLS. With no anon SELECT policy, events are silently dropped for the anon role. No error is thrown; the subscription appears to succeed but delivers nothing.

  **Fix:** Added a `SECURITY DEFINER` function `public.anon_can_read_conversation(uuid)` that checks whether a conversation UUID exists in the `conversations` table. The function executes as its owner (bypassing conversations' RLS), returns only a boolean, and is granted `EXECUTE` to the anon role only. A new anon SELECT policy on `messages` uses this function as its `USING` clause: anon users may read messages whose `conversation_id` maps to a real conversation.

  **Security model:** UUID unguessability (128-bit random) is the guard for direct REST API access. Realtime delivery is additionally scoped by the client-side channel filter (`conversation_id=eq.<id>`), so a patient only receives messages for their own conversation. The `conversations` table itself remains inaccessible to direct anon queries (no anon policy on `conversations`). See migration 0003 for the production hardening path (custom JWTs).

  **Deploy action required:** Run `0003_anon_messages_rls.sql` against the Supabase project SQL editor, or re-run `0001_initial_schema_idempotent.sql` for a fresh setup.

## [0.7.3] — 2026-03-17

### Changed

- **Clinic configuration is now injectable via environment variables** (`lib/conversation/prompts.ts`, `config/constants.ts`, `chat-ui.tsx`): Removed all hardcoded "Bright Smile Dental" references. A new `getClinicConfig()` function reads `NEXT_PUBLIC_CLINIC_NAME`, `CLINIC_ADDRESS`, `CLINIC_PHONE`, `CLINIC_HOURS`, `CLINIC_EMERGENCY_PHONE`, `CLINIC_WEBSITE`, `CLINIC_ACCEPTED_INSURANCE`, and `CLINIC_SERVICES` from the environment, falling back to `DEFAULT_CLINIC_CONFIG` values when unset. `AI_GREETING` is now `getAIGreeting()` and uses `NEXT_PUBLIC_CLINIC_NAME`. The chat UI header and the greeting message both derive the clinic name from the env var. Documented in `.env.example` and `.env.local`.

## [0.7.2] — 2026-03-17

### Fixed

- **Appointment date/time normalization before DB insert** (`services/appointment.service.ts`): Added `normalizePreferredDate` and `normalizeTimeOfDay` functions that sanitize LLM free-text before it reaches the database.
  - `preferred_date`: parsed with `Date.parse`; formatted as `YYYY-MM-DD` using UTC methods to avoid timezone day-shifts; ISO date roll-overs (e.g. `"2026-02-30"`) detected via round-trip comparison and rejected to null; relative phrases ("next Monday", "tomorrow") that `Date.parse` cannot resolve fall back to null.
  - `preferred_time_of_day`: mapped to `'morning' | 'afternoon' | 'evening' | 'any' | null` via exact-match first, then keyword/clock-time heuristics (e.g. `"2pm"` → `'afternoon'`, `"early morning"` → `'morning'`, `"after work"` → `'evening'`, `"anytime"` → `'any'`). Any unparseable value falls back to null instead of triggering the DB `CHECK` constraint violation.

## [0.7.1] — 2026-03-17

### Fixed

- **Auto-claim now sets `ai_enabled: false`** (`reply/route.ts`): The auto-claim path (first staff reply from `waiting_human`) now passes `{ status: 'human_active', ai_enabled: false }`, matching the explicit takeover route and closing the invariant gap where AI could theoretically still be enabled.
- **System message returned in reply response** (`reply/route.ts`, `conversation-detail.tsx`): On auto-claim the server returns `{ message, systemMessage }`. The dashboard client appends the join notification **before** the staff reply, so "A staff member has joined" renders in correct order without relying on non-deterministic realtime delivery.
- **Auto-claim seenIdsRef pre-seeds both messages** (`conversation-detail.tsx`): Both `systemMessage.id` and `message.id` are added to `seenIdsRef` before the realtime events arrive, preventing duplicate renders.
- **Patient chat shows system notifications** (`chat-ui.tsx`): Realtime handler now accepts `human` and `system` roles. The patient sees "A staff member has joined the conversation." as a centered divider-style notification.
- **`system` role added to `Message` type** (`chat-message.tsx`): `ChatMessage` renders system messages as a horizontal-rule notification (no avatar, centered italic text) and retains normal rendering for all other roles.

## [0.7.0] — 2026-03-17

### Fixed

- **Patient message history on conversation resume** (`use-chat.ts`, `api/chat/start`): The chat widget was calling `GET /api/conversations/[id]/messages` when resuming an existing conversation. That endpoint requires staff auth — patients don't have it, so message history silently failed to load for returning users. Fixed by having `POST /api/chat/start` return `messages[]` in the response for resumed conversations. The widget now reads `json.data.messages` directly; the staff endpoint call is removed entirely.

- **Middleware auth check replaced cookie heuristic with real session** (`middleware.ts`, `lib/supabase/middleware.ts`): The middleware protected `/dashboard` by checking for a cookie named `sb-*-auth-token`. This heuristic would (a) fail if Supabase changed its cookie naming and (b) allow a stale cookie to pass the pre-check even after the session expired, forcing an extra network hop to the layout. `updateSession` now returns the authenticated `user` object alongside the response; the middleware gates on that instead. No cookie-name pattern matching remains.

- **Unused `channelConfig` variable removed** (`use-realtime.ts`): A dead variable `const channelConfig: … = undefined` was declared but never referenced. Removed to keep the file clean.

### Improved

- **Rate limiting: IP-based layer added** (`lib/rate-limit.ts`, `api/chat/route.ts`, `api/chat/start/route.ts`): Added a `getClientIp()` helper that reads `x-forwarded-for` / `x-real-ip` headers (set by Vercel). Both chat endpoints now apply an IP-level gate (100 msg/min, 30 starts/min) in addition to the session-token gate. This limits the blast radius when a client rotates session tokens to bypass per-token limits.

- **Rate limiter multi-instance caveat documented** (`lib/rate-limit.ts`): Added a clear comment explaining that the in-memory store is per-serverless-instance and does not provide global guarantees on Vercel. Added Upstash Redis as the recommended upgrade path, with the required env vars listed in `.env.example`.

- **`.env.example` updated with production guidance**: Clarified that `NEXT_PUBLIC_APP_URL` must be set to the production URL on Vercel (not `localhost`). Added commented-out `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` placeholders for the rate-limiter upgrade path.

### Remaining pre-deploy checklist (non-code)

- Supabase Dashboard → Replication: add `messages` and `conversations` to the `supabase_realtime` publication (required for realtime hooks to fire).
- Vercel environment variables: set all vars from `.env.example` — especially `NEXT_PUBLIC_APP_URL` (production domain), `SUPABASE_SERVICE_ROLE_KEY`, and `OPENAI_API_KEY`.
- Confirm `OPENAI_MODEL` value is accessible on your API key (default `gpt-4o-mini` is safe; `gpt-4.1` requires access).
- Vercel project: ensure the build command is `next build` and output directory is `.next`.

## [0.6.0] — 2026-03-17

### Fixed

- **System messages now centred in conversation detail**: `ROLE_STYLES` had an `align` property for system messages (`mx-auto`) that was never applied to the DOM. Replaced with a `container` property (Flexbox justify class) used on the outer row div. Patient → `justify-end`, AI/Staff → `justify-start`, System → `justify-center`. Fixes Test 6.3.
- **Supabase Realtime publication added to idempotent migration**: `conversations` and `messages` tables were not in the `supabase_realtime` publication. Without this, `useRealtimeConversations` and `useRealtimeMessages` receive no events and the dashboard never auto-refreshes. Added idempotent `ALTER PUBLICATION` statements to `0001_initial_schema_idempotent.sql`. Fixes Test 6.1 after migration re-run.

### Audited (no changes needed)

- **Test 6.2 — Auth gating**: Confirmed correct. `/dashboard` is protected by middleware cookie pre-check and server-side layout `getUser()`. All staff API routes call `requireStaffAuth()` returning 401 for unauthenticated callers.
- **Test 6.4 — Lead creation**: Confirmed correct. `isIdentified` in `chat.service.ts` evaluates `first_name && (phone || email)` after enrichment. `ensureLead` creates the lead and `conversation.lead_id` is updated in the same turn.

## [0.5.0] — 2026-03-17

### Fixed

- **Handoff idempotency (service layer)**: `handoff.service.createHandoff()` now calls `getOpenHandoffForConversation()` before inserting. Concurrent or retried escalation events for the same conversation return the existing open handoff instead of creating duplicates. Also heals state if a previous attempt created the event but crashed before the conversation status update.
- **End-conversation / escalation conflict in `chat.service`**: The `transitionStatus('resolved')` branch is now guarded with `!turnResult.escalation.shouldEscalate`. Previously, a turn where the engine both escalated and set `next_action: 'end_conversation'` could race `waiting_human → resolved`, clobbering the handoff.
- **Patient UI reflects `waiting_human` state**: `ChatUI` now checks `conversation.ai_enabled` and `conversation.status` in the `/api/chat` response. On escalation the input is replaced with an amber "A staff member will be with you shortly" banner. The same check fires at conversation start so a patient who reloads mid-handoff also sees the banner immediately.
- **Redundant "AI Paused" badge hidden**: The "AI Paused" badge no longer appears alongside "Needs Attention" (`waiting_human`) or "Staff Active" (`human_active`) in the conversations list — those labels already convey AI is off. The badge is still shown for any future edge state where `ai_enabled: false` with `status: active`.

## [0.4.1] — 2026-03-17

### Fixed

- **Appointment type labels now match DB enum** (`appointments-list.tsx`): Removed stale label keys (`cleaning`, `consultation`, `follow_up`, `orthodontics`, `extraction`, `root_canal`, `implant`) that don't exist in the `appointment_type` DB enum. Added the two missing keys `implant_consult` and `orthodontic_consult`. Previously these badge labels silently fell through to `toTitleCase`.
- **Expanded service-type → appointment-type mapping** (`appointment.service.ts`): Added 20+ normalised variants the LLM commonly produces (`"new patient"`, `"exam"`, `"check-up"`, `"teeth whitening"`, `"braces"`, `"invisalign"`, etc.). Previously all these fell through to `'other'`, producing unhelpful "Other" badges in the appointments dashboard.
- **DB-level deduplication constraint** (`0002_appointment_request_dedup.sql`): Added a partial unique index on `appointment_requests (conversation_id)` where `status IN ('pending', 'confirmed')`. Backs up the application-layer `SELECT`-before-`INSERT` check and closes the theoretical TOCTOU race window. A cancelled request does not block a subsequent re-request in the same conversation. Idempotent migration also updated.

## [0.4.0] — 2026-03-17

### Fixed

- **Patient chat receives staff replies in real time**: `ChatUI` now subscribes to `useRealtimeMessages` for the active conversation. Only `human` role inserts are processed; `patient` and `ai` messages continue to be handled via the HTTP response. A `seenIdsRef` (seeded with greeting and AI reply IDs) prevents duplicates on reconnect.
- **Staff messages render distinctly**: Extended `Message.role` to include `"staff"`. `ChatMessage` renders staff messages left-aligned with a green avatar ("ST") and a green-tinted bubble — visually distinct from both AI and patient messages.
- **Conversation resume after handoff**: `startOrResumeConversation()` now resumes conversations in `active`, `waiting_human`, or `human_active` status. Previously only `active` was resumed, causing a new conversation to be created when a patient returned during or after a handoff.
- **Duplicate appointment requests prevented**: `appointment.service.createRequest()` now calls `getOpenAppointmentRequestForConversation()` before inserting. If a `pending` or `confirmed` request already exists for the conversation, the existing record is returned and no duplicate is created.
- **Reply auto-claim now fully consistent with explicit takeover**: When a staff reply auto-claims a `waiting_human` conversation, the route now also inserts a "A staff member has joined the conversation." system message and calls `assignHandoffEvent()` — matching the behaviour of `POST .../takeover`.

## [0.3.0] — 2026-03-17

### Fixed

- **Resolve flow**: `PATCH /conversations/[id]` now also sets `ai_enabled: false` and inserts a system message ("This conversation has been resolved.") when resolving; abandoned state gets its own system message too
- **System message on resolve**: system message is returned in the API response and immediately appended to the client message list — no extra round-trip needed
- **Duplicate realtime reply**: confirmed already fixed via `seenIdsRef` deduplication in `ConversationDetail` — staff-sent messages are marked seen before realtime fires

### Added

- **Last-message preview** in conversations list: each row now shows a truncated preview of the most recent patient/AI/staff message with a role prefix ("Patient:", "AI:", "Staff:")
- **AI Paused badge** now also hidden for `abandoned` conversations (in addition to `resolved`)

### Already present (confirmed in audit)

- `waiting_human` → "Needs Attention" label
- `abandoned` included in filter tabs
- Channel slugs mapped to readable labels (Web Chat, SMS, WhatsApp…)
- "AI Paused" badge label
- Empty state messages for filtered views
- Status badge colours for all five states
- "Escalation reason:" label in handoff card
- "Sending a reply will claim this conversation" note in reply box
- ⌘ Cmd / Ctrl + Enter hint in reply box

## [0.2.0] — 2026-03-16

### Added

#### Phase 1: Staff Authentication
- Supabase Auth integration with cookie-based sessions
- Staff login page at `/login` with email/password
- Auth middleware that refreshes sessions and protects `/dashboard` routes
- `requireStaffAuth()` helper for API route protection
- Login/logout API routes (`/api/auth/login`, `/api/auth/logout`)
- All staff API routes now require authentication (conversations, leads, appointments, handoffs)
- Patient chat routes (`/api/chat/*`) remain public with session-token auth

#### Phase 2: Staff Dashboard MVP
- Dashboard layout with navigation (Conversations, Leads, Appointments)
- Conversations list view with status filtering (All, AI Active, Waiting for Staff, Staff Active, Resolved)
- Conversation detail view with full message history, contact info, and handoff info
- Leads list view showing contact info, status, treatment interest, and source
- Appointment requests list view with confirm/cancel actions
- Status badge colors and human-readable labels throughout

#### Phase 3: Human Takeover / Staff Reply Flow
- `POST /api/conversations/[id]/reply` — staff sends messages to patients (stored as `human` role)
- `POST /api/conversations/[id]/takeover` — staff claims a conversation (transitions to `human_active`, inserts system message)
- Conversation detail includes reply textarea with Cmd+Enter to send
- Take Over and Resolve buttons on conversation detail
- Proper status transitions: `waiting_human` → `human_active` → `resolved`
- Staff user ID and email stored in message metadata for auditability

#### Phase 4: Realtime Updates
- Supabase browser client for Realtime subscriptions
- `useRealtimeMessages` hook — live new messages in conversation detail
- `useRealtimeConversations` hook — auto-refresh conversations list on status changes
- `useRealtimeTable` generic hook for subscribing to any table
- Auto-scroll to new messages in conversation detail

#### Phase 5: Production Hardening
- In-memory rate limiter with sliding window
- Chat message endpoint: 20 requests/minute per session token
- Chat start endpoint: 10 requests/minute per session token
- Automatic cleanup of expired rate limit entries

## [0.1.0] — 2026-03-15

### Added
- Initial project setup with Next.js 16, TypeScript, Tailwind CSS v4, shadcn/ui
- Patient chat widget with AI receptionist (OpenAI gpt-4o-mini)
- Conversation engine with 26 intents, 5 urgency levels, deterministic escalation
- Supabase integration (contacts, conversations, messages, leads, appointment_requests, handoff_events)
- Automatic lead creation on patient identification
- Automatic appointment request creation
- Automatic handoff on escalation triggers
- Layered system prompt with safety rules and few-shot examples
