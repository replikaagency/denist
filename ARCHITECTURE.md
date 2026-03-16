# Dental Reception AI — System Architecture

> **Version**: 0.2.0  
> **Status**: Architecture finalized — ready for implementation  
> **Stack**: Next.js 16 (App Router) · TypeScript · Tailwind CSS v4 · shadcn/ui · Supabase · OpenAI · Zod 4

---

## 0. Audit of Current Codebase

Before prescribing architecture, here is an honest assessment of what exists today.

### What's solid

- **DB schema** (`0001_initial_schema.sql`): 6 well-normalized tables, proper enums, RLS enabled, good indexes, `updated_at` triggers. Production-quality.
- **Type system** (`types/database.ts`): Full `Database` generic type compatible with `@supabase/supabase-js`. Insert/Update aliases derived from it.
- **DB helpers** (`lib/db/`): Thin, consistent wrappers around Supabase admin client. Good error handling via `AppError`.
- **Error/response layer** (`lib/errors.ts`, `lib/response.ts`): Consistent `ApiSuccess<T> | ApiError` envelope. Central `handleRouteError` catches typed and untyped errors.
- **Conversation engine** (`lib/conversation/`): Sophisticated taxonomy (26 intents, 5 urgency levels), field collection strategy, deterministic escalation rules, fallback rewrites, state merge. This is the crown jewel.
- **Example conversations** (`lib/conversation/examples.ts`): 10 multi-turn examples covering happy path, emergency, insurance, complaints, ambiguity, out-of-scope. Excellent for few-shot and testing.
- **Zod validation schemas** (`lib/schemas/`): Proper API input validation, separate from LLM output schemas. Correct separation.

### What's broken or unfinished

| Problem | Impact | Section that addresses it |
|---------|--------|--------------------------|
| **Two competing AI architectures** — `lib/ai/` uses function-calling tools, `lib/conversation/` uses structured JSON output. Neither calls the other. | The route handler uses `lib/ai/` while the superior `lib/conversation/` engine sits unused. | §2 (Service Layer), §3 (AI Architecture Reconciliation) |
| **No service layer** — the chat route handler is 185 lines of orchestration logic mixing validation, DB calls, AI calls, and tool-call side-effects inline. | Untestable, unreusable, and will get worse as features are added. | §2 |
| **ConversationState has no persistence** — `lib/conversation/schema.ts` defines state but it's never stored. The route doesn't load or save it. | The structured-output engine cannot function across turns without persisted state. | §4 (State Model) |
| **PatientChat is fully mocked** — uses `setTimeout` for fake replies, not wired to any API. | No working patient-facing chat. | §6 (Component Architecture) |
| **ARCHITECTURE.md (old) describes tables that don't exist** — references `clinics`, `users`, `availability_slots`, none of which are in the actual migration. | Misleading. The real schema is single-clinic. | This document replaces it. |
| **No auth middleware** — dashboard routes have no authentication check. | Any API call to `/api/conversations` or `/api/leads` is unprotected. | §5 (Route Architecture) |
| **No rate limiting** — the public chat endpoint has no protection against abuse. | OpenAI credit burn risk. | §7 (Conventions) |
| **`lib/ai/prompts.ts` is a flat string** while `lib/conversation/prompts.ts` is a layered, parameterized prompt builder. Both exist. | Duplication and confusion about which is canonical. | §3 |

### Decision: structured-output engine wins

The `lib/conversation/` approach is architecturally superior to the function-calling approach in `lib/ai/` for this product:

1. **Deterministic safety** — escalation and fallback rules are hard-coded, not prompt-dependent.
2. **Auditable** — every turn produces a full classification + extracted fields + reasoning, stored in the DB.
3. **Testable** — `processTurn()` is a pure function (LLM output string in, `TurnResult` out). The function-calling approach has side-effects baked in.
4. **State accumulation** — the structured engine merges fields across turns, tracks low-confidence streaks, prevents urgency downgrade. The function-calling approach is stateless.

The function-calling tools (`collect_patient_info`, `request_appointment`, `escalate_to_human`) should be **reimplemented as post-engine side-effects** triggered by the conversation engine's `next_action` and escalation decisions, not as OpenAI tools.

---

## 1. Folder Architecture

```
src/
├── app/
│   ├── (public)/                           # No auth required
│   │   └── chat/page.tsx                   # Patient-facing web chat (MVP: single clinic)
│   │
│   ├── (auth)/                             # Auth flow (Phase 2)
│   │   ├── login/page.tsx
│   │   └── callback/route.ts
│   │
│   ├── (dashboard)/                        # Authenticated clinic staff
│   │   ├── layout.tsx                      # Shell: sidebar + topbar + auth guard
│   │   ├── overview/page.tsx               # KPIs, recent activity
│   │   ├── conversations/
│   │   │   ├── page.tsx                    # List (filterable by status)
│   │   │   └── [id]/page.tsx              # Detail view + takeover
│   │   ├── leads/
│   │   │   ├── page.tsx                    # Lead table
│   │   │   └── [id]/page.tsx              # Lead detail
│   │   ├── appointments/page.tsx           # Appointment request queue
│   │   └── settings/page.tsx              # Clinic config, AI prompt tuning
│   │
│   ├── api/
│   │   ├── chat/
│   │   │   ├── route.ts                    # POST — patient sends message (public)
│   │   │   └── start/route.ts              # POST — create/resume conversation (public)
│   │   │
│   │   ├── conversations/
│   │   │   ├── route.ts                    # GET — list (staff, authed)
│   │   │   └── [id]/
│   │   │       ├── route.ts                # GET, PATCH — detail, update
│   │   │       ├── messages/route.ts       # GET — message history
│   │   │       ├── handoff/route.ts        # POST — trigger handoff
│   │   │       ├── takeover/route.ts       # POST — staff claims conversation
│   │   │       ├── reply/route.ts          # POST — staff sends message
│   │   │       └── resolve/route.ts        # POST — mark resolved
│   │   │
│   │   ├── leads/
│   │   │   ├── route.ts                    # GET — list (staff)
│   │   │   └── [id]/route.ts              # GET, PATCH — detail, update
│   │   │
│   │   └── appointment-requests/
│   │       ├── route.ts                    # GET — list (staff)
│   │       └── [id]/route.ts              # GET, PATCH — detail, confirm/cancel
│   │
│   ├── layout.tsx                          # Root layout
│   ├── page.tsx                            # Landing / marketing
│   └── globals.css
│
├── components/
│   ├── ui/                  # shadcn primitives — never import from lib/ or services/
│   ├── chat/                # Patient chat components
│   ├── dashboard/           # Staff dashboard components
│   └── shared/              # Cross-cutting (status badges, timestamps, empty states)
│
├── services/                # ★ THE SERVICE LAYER — all business logic lives here
│   ├── chat.service.ts      # Orchestrates a full chat turn (the "god function" replacement)
│   ├── contact.service.ts   # Contact resolution, enrichment, de-duplication
│   ├── lead.service.ts      # Lead lifecycle, status transitions, qualification
│   ├── appointment.service.ts   # Appointment request creation and management
│   ├── handoff.service.ts   # Escalation, handoff creation, staff assignment
│   └── conversation.service.ts  # Conversation CRUD, status transitions, state persistence
│
├── lib/
│   ├── supabase/
│   │   ├── client.ts        # Browser client (createBrowserClient)
│   │   ├── server.ts        # Server Component / Route Handler client (authed)
│   │   └── admin.ts         # Service-role client (bypasses RLS)
│   │
│   ├── ai/
│   │   ├── client.ts        # OpenAI client singleton
│   │   ├── completion.ts    # Raw LLM call (messages in, structured JSON out)
│   │   └── classify.ts      # Fire-and-forget async classification (Phase 2)
│   │
│   ├── conversation/        # ★ CONVERSATION DOMAIN — pure logic, no I/O
│   │   ├── taxonomy.ts      # Intent enum, urgency enum, groups, signals, thresholds
│   │   ├── schema.ts        # LLMTurnOutput, ConversationState, PatientFields, etc.
│   │   ├── fields.ts        # Required fields per intent, getMissingFields()
│   │   ├── prompts.ts       # Layered system prompt builder
│   │   ├── engine.ts        # processTurn(), checkEscalation(), applyFallbacks(), mergeState()
│   │   ├── examples.ts      # 10 multi-turn example conversations
│   │   └── index.ts         # Barrel export
│   │
│   ├── db/                  # Thin data-access layer — one file per table
│   │   ├── contacts.ts
│   │   ├── conversations.ts
│   │   ├── messages.ts
│   │   ├── leads.ts
│   │   ├── appointments.ts
│   │   └── handoffs.ts
│   │
│   ├── schemas/             # Zod schemas for API input validation
│   │   ├── message.ts
│   │   ├── conversation.ts
│   │   ├── lead.ts
│   │   ├── appointment.ts
│   │   ├── contact.ts
│   │   └── handoff.ts
│   │
│   ├── errors.ts            # AppError class, error codes, HTTP status mapping
│   └── response.ts          # successResponse(), errorResponse(), handleRouteError()
│
├── hooks/                   # React hooks (useChat, useConversations, useLeads, etc.)
├── types/
│   └── database.ts          # Row types mirroring Supabase schema
└── config/
    └── constants.ts         # Limits, defaults, feature flags
```

### Key architectural boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│  PRESENTATION LAYER                                             │
│  app/ (routes, pages) + components/ + hooks/                    │
│  • Knows about: services, types                                 │
│  • Never imports from: lib/db/, lib/ai/, lib/conversation/      │
├─────────────────────────────────────────────────────────────────┤
│  SERVICE LAYER                                                  │
│  services/                                                      │
│  • Orchestrates business operations                             │
│  • Calls lib/db/ for persistence                                │
│  • Calls lib/ai/ for LLM completions                            │
│  • Calls lib/conversation/ for domain logic                     │
│  • Each function = one business operation (testable, composable)│
├─────────────────────────────────────────────────────────────────┤
│  DOMAIN LAYER                                                   │
│  lib/conversation/                                              │
│  • Pure functions, zero I/O                                     │
│  • Intent taxonomy, field requirements, escalation rules        │
│  • processTurn() is deterministic given (llmOutput, state)      │
├─────────────────────────────────────────────────────────────────┤
│  INFRASTRUCTURE LAYER                                           │
│  lib/db/ + lib/ai/ + lib/supabase/                              │
│  • I/O only — DB queries, LLM API calls                         │
│  • No business logic                                            │
│  • Thin wrappers with error handling                            │
└─────────────────────────────────────────────────────────────────┘
```

**Import rule**: dependencies flow downward. `app/` → `services/` → `lib/`. Never upward. `lib/conversation/` never imports from `lib/db/` or `lib/ai/`.

---

## 2. Service Layer Design

The service layer is the most important missing piece. It replaces the 185-line inline orchestration in `api/chat/route.ts` with composable, testable functions.

### `services/chat.service.ts` — the core orchestrator

```
processChatMessage(input: { session_token, conversation_id, content })
  │
  ├─ 1. Resolve contact        → contact.service.ts
  ├─ 2. Verify conversation     → conversation.service.ts
  ├─ 3. Guard: is AI active?    → conversation.service.ts
  ├─ 4. Persist patient message  → lib/db/messages.ts
  ├─ 5. Load conversation state  → conversation.service.ts
  ├─ 6. Build prompt             → lib/conversation/prompts.ts
  ├─ 7. Call LLM                 → lib/ai/completion.ts
  ├─ 8. Parse + validate output  → lib/conversation/engine.ts (parseLLMOutput)
  ├─ 9. Process turn             → lib/conversation/engine.ts (processTurn)
  ├─ 10. Execute side-effects based on engine output:
  │     ├─ If escalation → handoff.service.ts
  │     ├─ If patient_fields extracted → contact.service.ts
  │     ├─ If next_action = offer_appointment → appointment.service.ts
  │     └─ If completed → conversation.service.ts (mark resolved)
  ├─ 11. Persist AI message      → lib/db/messages.ts
  ├─ 12. Persist updated state   → conversation.service.ts
  └─ 13. Return ChatTurnResult
```

### Service responsibilities

| Service | Owns | Key methods |
|---------|------|-------------|
| `chat.service` | Full chat turn orchestration | `processChatMessage()` |
| `contact.service` | Contact resolution, enrichment, merge | `resolveContact(sessionToken)`, `enrichContact(id, fields)`, `deduplicateContact(email, phone)` |
| `conversation.service` | Conversation lifecycle + state | `startOrResumeConversation()`, `loadState(id)`, `saveState(id, state)`, `transitionStatus()` |
| `lead.service` | Lead funnel transitions | `ensureLead(contactId)`, `advanceStatus()`, `qualifyLead()` |
| `appointment.service` | Appointment request lifecycle | `createRequest()`, `confirmRequest()`, `cancelRequest()` |
| `handoff.service` | Escalation lifecycle | `createHandoff()`, `assignToStaff()`, `resolveHandoff()` |

### Design rules for services

1. **One public function = one business operation.** `processChatMessage()` is one function, not a class with mutable state.
2. **Services call `lib/db/` for data, `lib/conversation/` for logic, `lib/ai/` for LLM.** They never call each other's internal helpers.
3. **Services return typed results.** Never raw DB rows. Return `ChatTurnResult`, `LeadWithStatus`, etc.
4. **Services throw `AppError`.** Route handlers catch and convert to HTTP responses.
5. **No service is a singleton or class.** Plain exported functions. State lives in the DB.

---

## 3. AI Architecture Reconciliation

### Current state: two systems, zero integration

| | `lib/ai/` (function-calling) | `lib/conversation/` (structured-output) |
|--|---|---|
| **LLM interaction** | OpenAI function-calling tools | Structured JSON output via Zod schema |
| **Classification** | None — relies on tool calls | 26-intent taxonomy + 5 urgency levels |
| **Safety** | In the prompt only | Hard-coded escalation rules + fallback rewrites |
| **State** | Stateless per request | Cumulative `ConversationState` across turns |
| **Field collection** | Implicit (tool args) | Explicit per-intent requirements + one-at-a-time strategy |
| **Used by route handler?** | Yes | No |
| **Testable?** | No (side-effects in loop) | Yes (`processTurn` is pure) |

### Target: unified pipeline

```
Patient message
     │
     ▼
┌──────────────────────────────────────┐
│  chat.service.processChatMessage()   │
│                                      │
│  1. Load ConversationState from DB   │
│  2. Build layered system prompt      │  ← lib/conversation/prompts.ts
│  3. Call OpenAI (JSON mode)          │  ← lib/ai/completion.ts
│  4. Parse response with Zod          │  ← lib/conversation/engine.ts
│  5. Run processTurn():               │
│     • mergeState()                   │
│     • checkEscalation()              │
│     • applyFallbacks()              │
│  6. Execute side-effects:            │
│     • Enrich contact                 │
│     • Create appointment request     │
│     • Create handoff event           │
│  7. Save updated state to DB         │
│  8. Persist AI message               │
└──────────────────────────────────────┘
     │
     ▼
  ChatTurnResult → route handler → HTTP response
```

### What to do with `lib/ai/`

| File | Action |
|------|--------|
| `lib/ai/chat.ts` | **Delete.** Replace with `lib/ai/completion.ts` — a thin wrapper that calls OpenAI with JSON mode, returns raw string. No tool processing. |
| `lib/ai/tools.ts` | **Delete.** Side-effects are now triggered by `processTurn()` output, not by OpenAI tool calls. |
| `lib/ai/prompts.ts` | **Delete.** The flat string prompt is superseded by `lib/conversation/prompts.ts`. |

### `lib/ai/completion.ts` — what it should do

One function: `callLLM(systemPrompt: string, messages: ChatMessage[]): Promise<string>`

- Constructs the OpenAI request with `response_format: { type: "json_object" }`
- Returns the raw JSON string
- Tracks tokens, latency, model, finish_reason as metadata
- Handles retries (1 retry on 5xx)
- That's it. No parsing, no side-effects, no tool handling.

### Side-effect mapping

The conversation engine's output drives side-effects:

| Engine output | Side-effect |
|---------------|-------------|
| `output.patient_fields` has new values | `contact.service.enrichContact()` |
| `output.next_action === "offer_appointment"` | `appointment.service.createRequest()` |
| `escalation.shouldEscalate === true` | `handoff.service.createHandoff()` + `conversation.service.transitionStatus("waiting_human")` |
| `output.next_action === "end_conversation"` | `conversation.service.transitionStatus("resolved")` |
| Always | `lead.service.ensureLead()` once patient is identified |

---

## 4. State Model

### Conversation state persistence

`ConversationState` (defined in `lib/conversation/schema.ts`) must be persisted across turns. It tracks accumulated patient fields, current intent, urgency, low-confidence streaks, and completion status.

**Storage**: the existing `conversations.metadata` JSONB column. Store the full `ConversationState` object there.

```
conversations.metadata = {
  conversation_state: ConversationState,
  // ... other metadata (user agent, referrer, etc.)
}
```

**Load**: at the start of each turn, `conversation.service.loadState(id)` reads `metadata.conversation_state` and validates it against `ConversationStateSchema`. If missing (first turn), calls `createInitialState()`.

**Save**: at the end of each turn, `conversation.service.saveState(id, state)` writes the updated state back.

### Conversation lifecycle

```
                      ┌──────────────┐
         New msg  →   │    active    │
                      └──────┬───────┘
                             │
                 ┌───────────┼───────────────┐
                 │           │               │
                 ▼           ▼               ▼
          ┌─────────────┐  ┌──────────┐  ┌───────────┐
          │waiting_human│  │ resolved │  │ abandoned  │
          └──────┬──────┘  └──────────┘  └───────────┘
                 │                            ▲
                 ▼                            │
          ┌──────────────┐         (30 min inactivity
          │ human_active │          timeout — cron job)
          └──────┬───────┘
                 │
                 ▼
          ┌──────────┐
          │ resolved │
          └──────────┘
```

| Transition | Trigger | Guard |
|------------|---------|-------|
| → `active` | First patient message creates conversation | — |
| `active` → `waiting_human` | Engine escalation OR patient requests human OR handoff API | `status === 'active'` |
| `active` → `resolved` | Engine sets `completed = true` | All required fields filled |
| `active` → `abandoned` | Cron: no message for 30 min | `status === 'active'` |
| `waiting_human` → `human_active` | Staff clicks "Take over" | `assigned_to` must be set |
| `waiting_human` → `resolved` | Staff resolves without taking over | — |
| `human_active` → `resolved` | Staff resolves conversation | — |

**Invariant**: when `status` leaves `active`, set `ai_enabled = false`. When staff sends conversation back to AI (future feature), set `ai_enabled = true` and `status = active`.

### Lead lifecycle

```
     ┌───────┐
     │  new  │  ← Created when contact is first identified (has name + phone/email)
     └───┬───┘
         │
         ▼
   ┌───────────┐
   │ contacted │  ← Staff follows up (manual transition)
   └─────┬─────┘
         │
         ▼
   ┌────────────┐
   │ qualified  │  ← Intent confirmed, patient responsive
   └─────┬──────┘
         │
         ▼
   ┌─────────────────────┐
   │ appointment_requested│  ← AI creates appointment request
   └─────┬───────────────┘
         │
         ▼
   ┌──────────┐
   │  booked  │  ← Staff confirms appointment
   └──────────┘

   (Any state) ──→ lost / disqualified
```

**Auto-transitions** (handled by services, not manually):
- `new` is set when `lead.service.ensureLead()` creates the lead
- `appointment_requested` is set by `appointment.service.createRequest()`
- `booked` is set by `appointment.service.confirmRequest()`
- All other transitions are manual (staff action via dashboard)

### Handoff lifecycle

```
Created ──→ Assigned ──→ Resolved
              │
              └──→ Resolved (staff resolves without full takeover)
```

Fields:
- `assigned_to`: null on creation, set when staff takes over
- `resolved_at`: null until closed
- `notes`: staff can add notes at any point

---

## 5. Route Architecture

### Public routes (rate-limited, session-token auth)

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| POST | `/api/chat/start` | Create/resume conversation | session_token |
| POST | `/api/chat` | Send message, get AI reply | session_token + conversation_id |

Both routes authenticate via `session_token` in the request body. The token is opaque, stored on the contact, and persisted in the browser (localStorage).

**Rate limit**: 20 messages per minute per session_token (implement with in-memory counter or Upstash Redis).

### Staff routes (Supabase Auth required)

All staff routes require a valid Supabase session. Enforce in middleware or per-route.

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/conversations` | List conversations (paginated, filterable) |
| GET | `/api/conversations/[id]` | Conversation detail + messages |
| PATCH | `/api/conversations/[id]` | Update status / ai_enabled |
| POST | `/api/conversations/[id]/takeover` | Staff claims conversation |
| POST | `/api/conversations/[id]/reply` | Staff sends message in conversation |
| POST | `/api/conversations/[id]/resolve` | Mark conversation resolved |
| POST | `/api/conversations/[id]/handoff` | Manually trigger handoff |
| GET | `/api/leads` | List leads (paginated, filterable) |
| GET | `/api/leads/[id]` | Lead detail |
| PATCH | `/api/leads/[id]` | Update lead status/notes |
| GET | `/api/appointment-requests` | List appointment requests |
| GET | `/api/appointment-requests/[id]` | Request detail |
| PATCH | `/api/appointment-requests/[id]` | Confirm/cancel/update |

### Route handler pattern

Every route handler should follow this exact pattern:

```typescript
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    // 1. Parse + validate input (Zod)
    // 2. Auth check (session_token or Supabase auth)
    // 3. Call ONE service function
    // 4. Return successResponse(result)
  } catch (err) {
    return handleRouteError(err);
  }
}
```

**Rule: route handlers are 10-30 lines.** All orchestration lives in services. If a route handler is longer than 30 lines, logic is leaking.

---

## 6. Component Architecture

### Chat components (`components/chat/`)

| Component | Responsibility |
|-----------|---------------|
| `ChatWidget` | Root container — manages session, conversation state, API calls |
| `ChatMessageList` | Scrollable message feed with auto-scroll |
| `ChatBubble` | Single message bubble — variant by role (ai, patient, human, system) |
| `ChatInput` | Text input + send button + disabled states during AI response |
| `ChatHeader` | Clinic branding, online indicator, "Talk to a person" button |
| `TypingIndicator` | Animated dots while AI is responding |
| `HandoffBanner` | "A staff member will be with you shortly" |

### Dashboard components (`components/dashboard/`)

| Component | Responsibility |
|-----------|---------------|
| `DashboardShell` | Layout: sidebar + topbar + content area |
| `Sidebar` | Navigation links, user menu |
| `ConversationList` | Filterable table with status tabs |
| `ConversationThread` | Message thread for a single conversation |
| `ConversationSidebar` | Patient info panel, lead status, urgency badge |
| `TakeoverBar` | Sticky action bar: "Take over", "Resolve", "Assign" |
| `LeadTable` | DataTable with sort, filter, status badges |
| `AppointmentQueue` | Pending appointment requests with confirm/cancel actions |

### Client-side data flow

```
ChatWidget
  │
  ├─ On mount: POST /api/chat/start → gets { conversation, contact }
  │            Stores session_token in localStorage
  │            Stores conversation_id in component state
  │
  ├─ On send:  POST /api/chat → sends { session_token, conversation_id, content }
  │            Gets back { message, contact }
  │            Appends to local message list
  │
  └─ On handoff banner: POST /api/conversations/[id]/handoff
                         Disables input, shows banner
```

No WebSocket/SSE for MVP. Simple request-response. Add Supabase Realtime subscriptions in Phase 2 for the dashboard and for staff messages appearing in patient chat during takeover.

---

## 7. Conventions

### File naming
- `kebab-case` for all files: `chat.service.ts`, `chat-message.tsx`, `appointment-requests/route.ts`
- One export per file for services and components. Barrel exports only in `lib/conversation/index.ts`.

### Import aliases
- `@/` maps to `src/`
- `@/services/` for services
- `@/lib/` for infrastructure
- `@/components/` for UI
- `@/types/` for types

### Error handling
- Services throw `AppError`. Route handlers catch and convert.
- Never swallow errors. If you catch, either re-throw or log + return a fallback.
- Use `AppError.database()`, `AppError.ai()`, `AppError.validation()` etc. for typed errors.

### Database access
- All DB access goes through `lib/db/`. No direct Supabase calls from services or route handlers.
- `lib/db/` uses the admin client (bypasses RLS) because route handlers validate auth themselves.
- Every `lib/db/` function returns typed rows or throws `AppError`.

### Zod schemas: two kinds, separate purposes
- `lib/schemas/` — API input validation. Used in route handlers.
- `lib/conversation/schema.ts` — LLM output validation + conversation domain types. Used in the engine.
- These are intentionally separate. Do not merge them.

### AI/LLM
- `lib/ai/` contains only I/O: the OpenAI client and the raw completion call.
- All LLM behavior (prompt construction, output parsing, safety rules, field extraction) lives in `lib/conversation/`.
- The system prompt is assembled from layers, not edited as a flat string.
- Few-shot examples are injected based on the current classified intent.

### Testing strategy (when added)
- `lib/conversation/` gets unit tests: `processTurn()`, `checkEscalation()`, `mergeState()` against the example conversations.
- Services get integration tests against a Supabase test project.
- Route handlers get thin tests (mock the service, verify HTTP status codes and response shapes).

---

## 8. Anti-Patterns to Avoid Now

### 1. "Fat route handler"
**Don't**: put orchestration logic (DB calls, AI calls, side-effects) inline in `route.ts`.  
**Do**: route handlers call one service function. Service functions orchestrate.

### 2. "Two AI systems"
**Don't**: maintain both function-calling tools and structured-output engine.  
**Do**: delete `lib/ai/tools.ts`, `lib/ai/chat.ts`, `lib/ai/prompts.ts`. Use the structured-output engine exclusively.

### 3. "Ephemeral conversation state"
**Don't**: reconstruct state from message history on every turn.  
**Do**: persist `ConversationState` in `conversations.metadata` and load/save on each turn.

### 4. "Diagnosis in the prompt only"
**Don't**: rely solely on prompt instructions to prevent diagnosis/pricing.  
**Do**: use `contains_diagnosis` and `contains_pricing` flags in the LLM output + `applyFallbacks()` to rewrite.

### 5. "Premature multi-tenancy"
**Don't**: add `clinic_id` to every table and build multi-tenant auth before you have one paying clinic.  
**Do**: keep the schema single-clinic. Design the service layer so adding `clinic_id` later is a mechanical change (add parameter, add WHERE clause). The current schema supports this — `contacts.metadata`, `conversations.metadata` can carry a `clinic_id` when needed.

### 6. "Custom auth"
**Don't**: build your own JWT/session system for staff.  
**Do**: use Supabase Auth. The RLS policies already support authenticated staff reads.

### 7. "Global OpenAI client state"
**Don't**: rely on module-level `let openaiClient: OpenAI | null = null` singletons.  
**Do**: use a lazy-initialized getter function (already done, but formalize it in `lib/ai/client.ts`).

### 8. "Component-level API calls"
**Don't**: call `fetch('/api/...')` from 15 different components.  
**Do**: centralize API calls in hooks (`hooks/use-chat.ts`, `hooks/use-conversations.ts`) that manage loading state, errors, and cache.

### 9. "Untyped metadata blobs"
**Don't**: throw random fields into `metadata` JSONB without validation.  
**Do**: define a Zod schema for each table's metadata shape. Validate on write. At minimum, validate `conversations.metadata.conversation_state` with `ConversationStateSchema`.

### 10. "Testing against production"
**Don't**: use the production Supabase project for development.  
**Do**: use `supabase start` for local development. Run migrations locally with `supabase db push`.

---

## 9. Roadmap: MVP → V1

### Phase 1 — Functional MVP (Weeks 1-3)

**Goal**: A working AI receptionist that captures leads from web chat.

| Week | Deliverables |
|------|-------------|
| 1 | **Service layer**: implement `chat.service`, `contact.service`, `conversation.service`. Wire the conversation engine to the LLM. Delete `lib/ai/chat.ts`, `lib/ai/tools.ts`, `lib/ai/prompts.ts`. State persistence in `conversations.metadata`. Refactor `POST /api/chat` to call `chat.service.processChatMessage()`. |
| 2 | **Patient chat UI**: Wire `PatientChat` to real APIs. Session management (localStorage token). Implement `POST /api/chat/start`. Handle handoff state in UI. Typing indicator. |
| 3 | **Lead + appointment flow**: `lead.service`, `appointment.service`, `handoff.service`. Auto-create leads when patient is identified. Create appointment requests when engine signals `offer_appointment`. Escalation side-effects. |

**MVP delivers**: Patient opens chat → AI converses naturally → collects name/phone/email → creates lead → handles appointment request intent → escalates when appropriate → all data in Supabase.

### Phase 2 — Staff Dashboard (Weeks 4-6)

| Week | Deliverables |
|------|-------------|
| 4 | **Auth + dashboard shell**: Supabase Auth (email/password). Dashboard layout with sidebar. Auth middleware on staff routes. |
| 5 | **Conversation management**: Conversation list with status filters. Conversation detail view with message thread. Takeover + resolve actions. Staff reply in conversation. |
| 6 | **Leads + appointments**: Lead table with status badges and filters. Lead detail with conversation link. Appointment request queue with confirm/cancel. |

### Phase 3 — Polish (Weeks 7-9)

| Feature | Details |
|---------|---------|
| Streaming responses | SSE from `POST /api/chat` for token-by-token display |
| Realtime dashboard | Supabase Realtime for live conversation/lead updates |
| Rate limiting | Per-session message throttling |
| Conversation summary | AI-generated summary after resolution (stored in `conversations.summary`) |
| Email notifications | New handoff → staff email alert |
| Embed code | Copy-paste chat widget snippet for clinic websites |

### Phase 4 — Production V1 (Weeks 10-14)

| Feature | Details |
|---------|---------|
| Multi-clinic | Add `clinics` table, `clinic_id` FK on all tables, RLS by clinic |
| Clinic settings | Per-clinic prompt configuration, hours, services, providers |
| WhatsApp | Webhook ingestion via Meta Cloud API, channel-aware routing |
| Analytics | Conversation volume, response time, lead conversion, AI accuracy |
| Observability | Structured logging, error tracking, LLM cost monitoring |
| Automated follow-ups | Post-appointment survey, no-show re-engagement |

---

## 10. Key Technical Decisions Summary

| Decision | Rationale |
|----------|-----------|
| **Structured-output over function-calling** | Deterministic safety, auditable classification, testable engine, cumulative state |
| **Service layer over fat route handlers** | Testable, reusable, composable business logic |
| **ConversationState in metadata JSONB** | Zero schema migration, Zod-validated, evolves with the engine |
| **Single-clinic MVP** | Ship faster. Multi-clinic is a mechanical refactor, not an architectural one. |
| **No streaming for MVP** | Simple request-response. Streaming adds complexity (SSE, partial state management) with minimal user-perceived benefit at low message volume. |
| **No Supabase Realtime for MVP** | Simple polling or refresh for dashboard. Realtime subscriptions in Phase 3. |
| **Zod 4** | Already in use. Shared between API validation and LLM output validation. |
| **Admin client for all DB access** | Route handlers validate auth themselves. RLS is a defense-in-depth layer for future direct-client access. |
| **session_token for anonymous patients** | Patients don't have accounts. Token in localStorage enables conversation resumption without auth. |
