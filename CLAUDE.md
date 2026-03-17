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
- Staff auth with Supabase Auth (login page, middleware, route protection)
- Staff dashboard with conversations list + detail, leads list, appointments list
- Human reply + takeover flow with status transitions
- Realtime updates on conversations list and message detail
- Basic rate limiting on chat endpoints

## Next priorities
- Test end-to-end flow with real Supabase project
- Add Supabase Realtime Postgres publication for `messages` and `conversations` tables
- Staff notifications for new handoffs (email or in-app)
- Conversation search/filter in dashboard
- Mobile-responsive dashboard
- Streaming AI responses

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
