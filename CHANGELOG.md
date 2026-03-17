# Changelog

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
