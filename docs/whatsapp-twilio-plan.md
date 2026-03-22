# Twilio WhatsApp — pre-integration notes

This document describes how to **activate** WhatsApp after the current stub phase. The codebase already includes DB support for `conversations.channel = 'whatsapp'` and `resolveContact({ channel: 'whatsapp', phone })` in [`src/services/contact.service.ts`](../src/services/contact.service.ts).

## Channel naming

| Product language | `ConversationChannel` (Postgres enum) |
|------------------|----------------------------------------|
| Web widget      | `web_chat`                             |
| WhatsApp        | `whatsapp`                             |

Do not introduce a parallel `"web"` string in the DB; keep using `web_chat` for compatibility.

## Required environment variables (future)

| Variable | Purpose |
|----------|---------|
| `TWILIO_ACCOUNT_SID` | Account identifier |
| `TWILIO_AUTH_TOKEN` | REST API + **webhook signature validation** (see Twilio docs) |
| `TWILIO_WHATSAPP_FROM` | Sandbox or approved sender, e.g. `whatsapp:+14155238886` |
| `TWILIO_WHATSAPP_INBOUND_ENABLED` | Must be `true` only when the inbound handler is fully implemented; until then leave unset or `false` |

Optional / documentation-only today:

- **Signature secret**: Twilio standard is validating `X-Twilio-Signature` with your **Auth Token** and the full request URL + body. A separate `TWILIO_WEBHOOK_SIGNATURE_SECRET` is only needed if you adopt Twilio’s alternate signing models — not required for the default flow.

## Inbound flow (to implement)

1. **POST** `application/x-www-form-urlencoded` to `/api/webhooks/twilio/whatsapp`.
2. **Validate** `X-Twilio-Signature` (use official Twilio helper or equivalent).
3. **Parse** `Body`, `From` (`whatsapp:+…`), `MessageSid` using [`normalizeTwilioWhatsAppInbound`](../src/lib/channels/twilio-webhook.ts).
4. **Resolve contact**: `resolveContact({ channel: 'whatsapp', phone })` (normalize E.164 consistently with [`lib/phone`](../src/lib/phone.ts)).
5. **Conversation**: find or create `conversations` row with `channel: 'whatsapp'` for that contact (pattern mirrors web: one active conversation or explicit policy).
6. **Session / auth bridge**: `processChatMessage` today expects `session_token` + `conversation_id`. For WhatsApp you must either:
   - issue a server-side token stored on `contacts.metadata.whatsapp_session_token` (or similar) and pass it to `processChatMessage`, **or**
   - add a narrow internal entry point (e.g. `processChatMessageForChannel`) that skips browser session — **avoid changing web behavior**; prefer a dedicated internal wrapper that still calls the same core pipeline.
7. **Persist** patient message then AI reply; today’s message rows and `conversation_events` stay the source of truth.
8. **Reply to Twilio**: return TwiML with `<Message>` **or** respond `200` quickly and send the outbound message asynchronously via REST (recommended under timeout pressure).

## Outbound flow (to implement)

- Use [`sendTwilioWhatsAppMessage`](../src/lib/channels/twilio-outbound.stub.ts) (replace stub body) with `TWILIO_WHATSAPP_FROM` → `whatsapp:+patient`.
- **24-hour session window**: inside the window, free-form text is allowed; outside it, use **approved templates** (WhatsApp / Twilio Content API). Document template SIDs per locale.
- **Staff dashboard replies**: today’s staff path writes human messages to DB; a Realtime subscriber on the patient side works for web. For WhatsApp, add a hook after staff `insertMessage` to call Twilio send when `conversation.channel === 'whatsapp'` (only when live).

## Message window / template caveats

- WhatsApp enforces marketing / utility template rules outside the customer service window.
- Twilio sandbox vs production sender approval are separate steps.
- Never log full message bodies from webhooks in production logs without a redaction policy (PHI).

## Stub behavior today

- [`route.ts`](../src/app/api/webhooks/twilio/whatsapp/route.ts): always `200` + empty `<Response/>`; **no** Twilio API calls, **no** `processChatMessage`.
- If `TWILIO_WHATSAPP_INBOUND_ENABLED=true` while still stubbed, a **warning** is logged so misconfiguration is visible.

## Activation checklist

1. Twilio WhatsApp sender approved (or sandbox for dev).
2. Set env vars; keep `TWILIO_WHATSAPP_INBOUND_ENABLED=false` until step 6 works end-to-end.
3. Implement signature validation + `normalizeTwilioWhatsAppInbound` wiring.
4. Implement conversation + session bridge → `processChatMessage` (or internal wrapper).
5. Implement outbound send + template policy.
6. E2E test: inbound → AI reply → optional staff reply → outbound.
7. Set `TWILIO_WHATSAPP_INBOUND_ENABLED=true` in staging only, then production.

## What remains intentionally inactive

- Real HTTP to Twilio (inbound parse beyond stub export, outbound send).
- Linking webhook to `processChatMessage`.
- Rate limits / idempotency by `MessageSid`.
- Staff reply → WhatsApp push.
