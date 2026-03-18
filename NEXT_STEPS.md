# Next Steps

> **As of**: 2026-03-18 · branch `feature/confirmation`

## Priority 1 — Before pilot (blocking)

- [ ] **End-to-end smoke test on real Supabase project**
  - Start a real conversation as a patient, confirm appointment, verify `appointment_requests` row in DB
  - Test reschedule flow (requires at least 1 existing `pending` request)
  - Test escalation → staff takeover → reply → resolve
  - Verify `SUPABASE_JWT_SECRET` is set and patient realtime works

- [ ] **Merge `feature/confirmation` to `main`**
  - Run `tsc --noEmit` and `next build` on the merged branch
  - No test suite exists — manual smoke test is the only gate

- [ ] **Validate `classifyConfirmation()` against real patient responses**
  - Risk: "ok" and "bueno" match as YES even mid-sentence
  - Either add negation context to the regex, or accept the risk and monitor

## Priority 2 — Pilot observability

- [ ] **Staff dashboard: show `awaiting_confirmation` indicator on conversation cards**
  - Conversations frozen mid-confirmation are invisible to staff today
  - A simple badge ("Awaiting patient confirmation") prevents staff confusion during takeover

- [ ] **Add confirmation expiry**
  - If `awaiting_confirmation=true` and no patient reply arrives within N turns, reset state and re-ask
  - Simple implementation: check `state.confirmation_attempts` on each turn start and expire after a threshold

## Priority 3 — Post-pilot

- [ ] Staff notifications for new handoffs (email)
- [ ] Conversation search/filter in dashboard
- [ ] Mobile-responsive dashboard
- [ ] Streaming AI responses
- [ ] Upstash Redis for global rate limiting (replace in-memory store)
- [ ] Automated test suite (unit tests for `engine.ts`, integration tests for `chat.service.ts`)

## Not planned (out of scope for MVP)

- Multi-clinic support
- WhatsApp integration
- Analytics dashboard
- Automated follow-ups
