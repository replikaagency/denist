# Project Status

> **Branch**: `feature/confirmation`
> **Date**: 2026-03-18
> **Version**: 1.1.0
> **Status**: Feature-complete. Awaiting end-to-end smoke test on production Supabase before pilot.

---

## What is built and working

| Area | Status | Notes |
|------|--------|-------|
| Patient web chat | ✅ Complete | Spanish, single-clinic |
| AI conversation engine | ✅ Complete | 26 intents, 5 urgency levels, deterministic safety |
| Contact resolution + enrichment | ✅ Complete | Session-token auth, dedup guard |
| Lead creation | ✅ Complete | Auto-created on patient identification |
| Appointment request creation | ✅ Complete | Idempotent, with explicit confirmation gate |
| Explicit confirmation flow | ✅ Complete | Patient must say "sí" before any DB write |
| Reschedule flow | ✅ Complete | Atomic cancel+create via Postgres RPC |
| Corrections / field overwrites | ✅ Complete | Audit log, 3+ corrections → escalation |
| Staff auth | ✅ Complete | Supabase Auth, cookie sessions |
| Staff dashboard | ✅ Complete | Conversations, leads, appointments |
| Human takeover + reply | ✅ Complete | Auto-claim, system message, realtime |
| Realtime (staff dashboard) | ✅ Complete | Supabase Realtime subscriptions |
| Realtime (patient chat) | ✅ Complete | Session-token scoped JWT, RLS-safe |
| Rate limiting | ✅ Complete | In-memory, per-instance (see risk below) |
| Spanish localization | ✅ Complete | Prompts, fallbacks, field labels, examples |
| Safety rules | ✅ Complete | Diagnosis/pricing/advice — double-gated (prompt + regex) |
| Handoff / escalation | ✅ Complete | Emergency, human-request, complaint, low-confidence, turn limit |

## What is NOT built

| Area | Notes |
|------|-------|
| Automated test suite | No unit or integration tests exist |
| Email notifications for handoffs | Listed in CLAUDE.md; not implemented |
| Conversation search/filter in dashboard | Listed in CLAUDE.md; not implemented |
| Mobile-responsive dashboard | Listed in CLAUDE.md; not implemented |
| Streaming AI responses | Not implemented |
| Multi-clinic support | Single-clinic MVP only |
| Per-clinic config in DB | Config is env-var based; no settings UI |

## Known risks before pilot

| Risk | Severity | Location |
|------|----------|----------|
| `classifyConfirmation()` matches "ok, but can I change..." as YES | Medium | `chat.service.ts:602` |
| `awaiting_confirmation` has no timeout — conversation stays locked if patient goes silent | Medium | `chat.service.ts:116` |
| Rate limiter is in-memory per serverless instance — does not enforce global limits on Vercel | Low-Medium | `lib/rate-limit.ts` |
| `SUPABASE_JWT_SECRET` missing silently disables realtime for patients (503, no error to staff) | Low | `api/chat/realtime-token/route.ts` |
| Staff dashboard has no indicator for conversations stuck in `awaiting_confirmation` | Low | `components/dashboard/` |
| Reschedule fallback creates a fresh booking if old request disappears — staff see no reschedule record | Low | `chat.service.ts:149` |

## Environment variables required

See `.env.example` for the full list. Critical vars:
- `OPENAI_API_KEY`
- `SUPABASE_URL` + `SUPABASE_ANON_KEY` + `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_JWT_SECRET` (required for patient realtime)
- `NEXT_PUBLIC_CLINIC_NAME` + clinic contact vars
- `OPENAI_MODEL` (default: `gpt-4o-mini`)

## Migrations

All migrations are in `supabase/migrations/`. Apply in order 0001→0006. Migrations 0001 and 0003 are idempotent (safe to re-run). Others are not.

| Migration | Purpose |
|-----------|---------|
| 0001 | Initial schema (idempotent) |
| 0002 | Appointment dedup index |
| 0003 | Anon RLS for patient realtime (idempotent) |
| 0004 | RLS tightened to session_token JWT |
| 0005 | Appointment request constraints |
| 0006 | Reschedule RPC + schema fields |
