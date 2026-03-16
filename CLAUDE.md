# Dental Reception AI

## Objective
Build the staff-side operational MVP for a dental AI receptionist.

## Current state
- Patient chat works
- Supabase is connected
- Conversation engine works
- Leads are created automatically
- Appointment requests are created automatically
- Handoff events are created automatically
- No staff dashboard UI yet
- No staff auth yet
- No realtime staff messaging yet
- No rate limiting yet

## Tonight priority
1. Staff auth with Supabase Auth
2. Protected staff dashboard
3. Staff conversations list + detail
4. Human reply / takeover flow
5. Realtime updates with Supabase Realtime
6. Basic production hardening

## Rules
- Do not redesign the patient chat unless required
- Work incrementally and keep the app compiling
- After each milestone:
  - run typecheck
  - fix errors before continuing
- Prefer safe, small commits
- Update CHANGELOG.md after each milestone
- If blocked, document the blocker and continue with the next unblocked task
- Prioritize functional completion over polish
