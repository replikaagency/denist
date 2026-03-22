# Pilot monitoring checklist

Use this during the first days/weeks of real-world deployment.

## API health

- Watch **HTTP 500** responses on `POST /api/chat` (hosting logs, Vercel, or application logs).
- Correlate spikes with OpenAI outages, Supabase errors, or unhandled exceptions in `processChatMessage`.

## Handoffs

- Review **handoff_events** / dashboard queue for:
  - **`confirmation_escalated`** — patient could not confirm after ambiguous replies (metadata on AI messages in `chat.service` confirmation intercept).
  - **`human` / `urgent` / `emergency`** escalations from the conversation engine (`checkEscalation` in `engine.ts`).

## Concurrency / double tab

- Same patient opening **two tabs** or double-submitting can interleave requests: conversation `metadata.conversation_state` is last-write-wins. If you see odd state (e.g. lost `awaiting_confirmation`), ask whether two clients hit the chat at once.
- **Mitigation for users:** single tab; avoid rapid duplicate sends (rate limits exist but do not serialize requests).

## Quick SQL ideas (Supabase)

- Recent errors: filter API logs or add temporary logging in production only if needed.
- Handoffs: `select * from handoff_events order by created_at desc limit 50;`
