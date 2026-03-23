# Handoff Document — Dental Reception AI

> **For**: Antigravity engineering team
> **Date**: 2026-03-18
> **Prepared by**: original development team
> **Branch**: `feature/confirmation` (not yet merged to `main`)

---

## What this product is

A Spanish-language AI receptionist for a dental clinic. Patients interact via a web chat widget. The AI collects their details, understands their intent, and registers appointment requests — without any staff involvement. Staff monitor and respond through a separate dashboard.

This is a real pilot product, not a prototype. The code is production-quality. Do not redesign the architecture.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript (strict) |
| Styling | Tailwind CSS v4 + shadcn/ui |
| Database | Supabase (Postgres + RLS + Realtime) |
| AI | OpenAI (structured JSON output, not function-calling) |
| Schema validation | Zod 4 |
| Deployment target | Vercel |

---

## Repository state

- **Active branch**: `feature/confirmation`
- **Main branch**: `main` (behind — merge not yet done)
- **Version**: 1.1.0
- **Last commit**: `feat: backend hardening - reschedule + confirmation prep`
- **TypeScript**: clean (no errors as of last check)
- **Tests**: none — manual smoke test is the only verification gate

---

## What is implemented

Everything listed below is complete and working:

- **Patient web chat** — Spanish, single-clinic, session-token auth via localStorage
- **AI conversation engine** — 26 intents, 5 urgency levels, deterministic safety rules, field collection state machine, fallback rewrites
- **Appointment booking flow** — collects required fields (service type, date, time, name, phone), enters explicit confirmation step, writes to DB only after patient says "sí"
- **Explicit confirmation gate** — patient must confirm before any `appointment_requests` row is created; see `docs/CONFIRMATION_ANALYSIS.md` for full design
- **Reschedule flow** — atomic cancel + create via Postgres RPC, handles 0/1/2+ open requests
- **Correction handling** — patient can correct appointment fields mid-conversation; every correction is logged with timestamp and old/new values
- **Escalation** — emergency urgency, human request, complaint, 3+ consecutive low-confidence turns, 20-turn limit; all deterministic (not prompt-dependent)
- **Contact resolution** — dedup by phone/email, session-token continuity across browser sessions
- **Lead creation** — auto-created when patient is identified (name + phone or email)
- **Staff auth** — Supabase Auth, cookie sessions, middleware protection
- **Staff dashboard** — conversations list with status filters, conversation detail with message thread, leads list, appointments queue
- **Human takeover** — staff can claim a conversation, reply as human, resolve; patient sees "a staff member has joined" notification
- **Realtime** — staff dashboard auto-updates via Supabase Realtime; patient chat receives staff replies in real time (session-token scoped JWT)
- **Rate limiting** — in-memory sliding window per session token and per IP (see risk below)
- **Safety rules** — no diagnosis, no pricing, no medical advice; double-gated (LLM self-report flag + server-side regex)
- **Spanish localization** — all prompts, fallbacks, field labels, examples, and system messages are in Spanish

---

## What is NOT implemented

Do not assume these exist:

- Automated test suite (unit or integration)
- Email notifications when a handoff is created
- Conversation search or filter in the dashboard
- Mobile-responsive dashboard
- Streaming AI responses
- Multi-clinic support (single-clinic MVP only)
- Per-clinic configuration UI (env-var based)
- WhatsApp or SMS channels
- Analytics or reporting
- Automated follow-ups

---

## How to run locally

```bash
npm install
cp .env.example .env.local
# Fill in OPENAI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY,
# SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET, and clinic vars
npm run dev
```

Apply Supabase migrations in order (0001 → 0006). Migrations 0001 and 0003 are idempotent.

```bash
# Using Supabase CLI
supabase db push
```

---

## Key environment variables

| Variable | Purpose | Required |
|----------|---------|---------|
| `OPENAI_API_KEY` | LLM calls | Yes |
| `OPENAI_MODEL` | Model ID (default: `gpt-4o-mini`) | No |
| `SUPABASE_URL` | Database URL | Yes |
| `SUPABASE_ANON_KEY` | Client-side Supabase auth | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side DB access (bypasses RLS) | Yes |
| `SUPABASE_JWT_SECRET` | Patient realtime token signing | Yes (realtime) |
| `NEXT_PUBLIC_CLINIC_NAME` | Shown in chat widget header and AI persona | Yes |
| `CLINIC_ADDRESS`, `CLINIC_PHONE`, `CLINIC_HOURS` | Injected into AI system prompt | Yes |
| `CLINIC_EMERGENCY_PHONE` | Used in emergency escalation template | Yes |

Full list in `.env.example`.

---

## Important files — where things live

| What | Where |
|------|-------|
| Main chat turn orchestration | `src/services/chat.service.ts` |
| AI conversation engine (pure logic) | `src/lib/conversation/engine.ts` |
| LLM output schema (Zod) | `src/lib/conversation/schema.ts` |
| Conversation state shape | `src/lib/conversation/schema.ts` (`ConversationState`) |
| Intent + urgency taxonomy | `src/lib/conversation/taxonomy.ts` |
| System prompt builder | `src/lib/conversation/prompts.ts` |
| Field requirements per intent | `src/lib/conversation/fields.ts` |
| Appointment creation + normalization | `src/services/appointment.service.ts` |
| DB layer (thin wrappers) | `src/lib/db/` |
| Chat API route (thin — delegates to service) | `src/app/api/chat/route.ts` |
| Staff dashboard pages | `src/app/dashboard/` |
| Database migrations | `supabase/migrations/` |
| Rate limiter | `src/lib/rate-limit.ts` |

---

## Architecture in one paragraph

Every patient message enters `processChatMessage()` in `chat.service.ts`. The service loads `ConversationState` from `conversations.metadata` in Supabase, checks for in-progress flows (confirmation intercept, reschedule target selection) that bypass the LLM entirely, then builds a layered system prompt and calls OpenAI in structured-output JSON mode. The response is validated with Zod, processed by the deterministic engine (`processTurn()` in `engine.ts`), and used to drive side-effects: contact enrichment, lead creation, appointment request creation (after explicit patient confirmation), and escalation/handoff. State is saved back to `conversations.metadata`. The LLM proposes; the engine decides.

---

## Top risks before pilot

| # | Risk | Impact | File |
|---|------|--------|------|
| 1 | `classifyConfirmation()` has no negation check — "ok, but can I change the date?" creates an appointment | Medium | `chat.service.ts:602` |
| 2 | `awaiting_confirmation` has no timeout — conversation stays locked if patient goes silent | Medium | `chat.service.ts:116` |
| 3 | Rate limiter is in-memory per Vercel instance — does not enforce global limits | Low-Medium | `lib/rate-limit.ts` |
| 4 | Missing `SUPABASE_JWT_SECRET` silently returns 503 on realtime token — staff see no error | Low | `api/chat/realtime-token/route.ts` |
| 5 | No staff dashboard indicator for `awaiting_confirmation` — staff takeover leaves flag set | Low | `components/dashboard/` |

For full details see `PROJECT_STATUS.md` and `docs/CONFIRMATION_ANALYSIS.md`.

---

## Immediate next priorities

1. Merge `feature/confirmation` → `main` after smoke test
2. Run end-to-end test on real Supabase project (booking + reschedule + escalation)
3. Add `awaiting_confirmation` badge to staff conversation list
4. Evaluate `classifyConfirmation()` regex against real patient phrasing

Full list in `NEXT_STEPS.md`.

---

## What NOT to do

- **Do not redesign the architecture.** The service layer, conversation engine, and state model are working and intentional. Read `ARCHITECTURE.md` (with its outdated warning) and `docs/AI_ORCHESTRATION_DESIGN.md` (which describes a proposed future design, not current reality) carefully before drawing conclusions.
- **Do not replace the single-LLM-call pipeline** with the 5-stage pipeline described in `docs/AI_ORCHESTRATION_DESIGN.md` without explicit alignment — that document is a future design proposal, not a requirement.
- **Do not modify the patient chat UI** unless required by a specific bug. It is intentionally minimal.
- **Do not add multi-clinic abstractions** to the MVP. The schema is single-clinic by design.
- **Do not run migrations on the production Supabase project** without verifying idempotency first (see migration table in `PROJECT_STATUS.md`).

---

## Contacts

Ask the original team about:
- The specific pilot clinic context and patient expectations
- Whether `classifyConfirmation()` edge cases were accepted or need fixing before go-live
- Vercel project and Supabase project access
