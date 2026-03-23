# Confirmation Flow — Design & Risk Analysis

> **Status**: Implemented and merged
> **Branch**: `feature/confirmation`
> **Date**: 2026-03-18

---

## What was implemented

The explicit appointment confirmation flow ensures no `appointment_requests` row is written to the database until the patient explicitly confirms with "sí" (or equivalent).

### State machine

```
All required fields collected
         │
         ▼
awaiting_confirmation = true
pending_appointment = snapshot of state.appointment
LLM bypassed — reply replaced with buildConfirmationSummary()
         │
         ▼  (next patient turn — LLM bypassed entirely)
   classifyConfirmation()
    ├── 'yes'       → createRequest() → clear state → completed=true
    ├── 'no'        → reset state → patient can modify fields
    └── 'ambiguous' → re-ask (up to 2 attempts) → escalate to human
```

### Key locations in code

| What | File | Lines |
|------|------|-------|
| Entry point (set awaiting_confirmation) | `src/services/chat.service.ts` | 518–528 |
| Confirmation intercept (bypass LLM) | `src/services/chat.service.ts` | 116–242 |
| Confirmation classifier | `src/services/chat.service.ts` | 600–607 |
| Confirmation summary builder | `src/services/chat.service.ts` | 613–625 |
| State schema fields | `src/lib/conversation/schema.ts` | 228–230 |
| Appointment row creation | `src/services/appointment.service.ts` | `createRequest()` |

Reschedule uses the same confirmation wrapper via `buildRescheduleConfirmationSummary()` at `chat.service.ts:491–501`.

### DB safety

- No DB write occurs until `confirmation === 'yes'`
- `createRequest()` is idempotent: partial unique index on `(conversation_id)` where `status IN ('pending', 'confirmed')` prevents duplicate rows even under concurrent requests
- All three state fields (`awaiting_confirmation`, `pending_appointment`, `confirmation_attempts`) use `.default()` so existing DB records parse correctly without a migration

---

## Risks

### 1. classifyConfirmation() false positives (Medium)

- **Location**: `src/services/chat.service.ts:602`
- **Problem**: The regex matches `ok`, `bueno`, `claro`, `perfecto` as YES with no negation check. "Ok, but can I change the date?" classifies as confirmed.
- **Impact**: Appointment created before patient intended to confirm
- **Mitigation options**: Add lookahead for negation words (`pero`, `cambiar`, `no`) within the same message; or accept and handle via post-creation cancellation flow

### 2. No timeout on awaiting_confirmation (Medium)

- **Location**: `src/services/chat.service.ts:116`
- **Problem**: If the patient goes silent mid-confirmation, `awaiting_confirmation=true` stays set indefinitely. The conversation is locked until the patient returns.
- **Impact**: Patient who returns hours later types anything and gets the confirmation prompt again — technically correct behavior but potentially confusing
- **Mitigation**: Add expiry by turn count or via a scheduled cron job

### 3. No staff visibility into awaiting_confirmation (Low)

- **Location**: Staff dashboard (`src/components/dashboard/`)
- **Problem**: Staff cannot see which conversations are waiting for patient confirmation
- **Impact**: If staff takes over a conversation in this state, the flag stays true and will intercept the next patient message even though a human has handled it
- **Mitigation**: Add an indicator badge to conversation list; clear `awaiting_confirmation` when staff takes over in `conversation.service.ts`

### 4. pending_appointment snapshot is immutable by design (Low / acceptable)

- **Location**: `src/services/chat.service.ts:116–242`
- **Problem**: The LLM is bypassed during confirmation, so a patient cannot update a field mid-confirmation — they must decline and re-enter the flow
- **Impact**: "No, actually make it Thursday" → classifies as 'no' (via `cambiar`) → state reset → patient must re-provide details already captured
- **Note**: This is intentional. The snapshot prevents partial state from leaking into the DB. The 'no' path is the correct correction mechanism.

---

## Prior analysis

This document replaces an earlier raw analysis produced on 2026-03-18. The conclusion of that analysis was:

> The explicit confirmation flow is already fully implemented end-to-end on this branch. No implementation work was needed — only edge case hardening and pilot observability remain.
