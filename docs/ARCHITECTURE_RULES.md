# Architecture rules (chat and conversation)

These rules keep the HTTP boundary thin and stop `chat.service.ts` from becoming a second engine.

## Where logic must live

| Responsibility | Location |
|----------------|----------|
| Session / ownership, message length, “can this conversation accept AI?” | `src/services/chat.service.ts` (orchestrator only) |
| Persist patient message, `touch`, refresh conversation row | `chat.service.ts` |
| Turn pipeline: state load, confirmation, booking branches, LLM, engine, side effects | `src/lib/conversation/process-chat-turn.ts` (`executeProcessChatTurn`) |
| Flow gates and step helpers | `src/lib/conversation/flow-rules.ts` |
| Intake helpers (tokens, prior messages, small state tweaks) | `src/lib/conversation/intake.service.ts`, `intake-capture.ts`, `intake-guards.ts` |
| Booking parsing, draft reset, LLM history shape | `src/lib/conversation/booking.service.ts`, `booking-intent.ts` |
| UX copy and string builders | `src/lib/conversation/response-builder.ts` |
| Confirmation / correction classification | `src/lib/conversation/confirmation.ts` |
| Domain services (appointments, handoff, hybrid booking) | `src/services/*.service.ts` (called from the lib turn, not from `chat.service.ts`) |

Shared types for the API boundary: `src/lib/conversation/chat-turn-types.ts`.

## Forbidden patterns (in `chat.service.ts`)

- **No business rules** for appointments, intents, field collection, or confirmation outcomes.
- **No LLM calls** (`callLLM`, prompt building beyond re-exporting types if ever needed).
- **No conversation state mutation** beyond what’s required for the orchestration step (today: none inside `chat.service.ts` except passing data through).
- **No new branching trees** for product behavior—if you need more than a couple of guard `if`s, move the branch into `process-chat-turn.ts` or a dedicated module.
- **Do not “just add a helper”** at the bottom of `chat.service.ts` for anything that interprets patient text or clinic policy.

## ESLint (enforced)

For `src/services/chat.service.ts` only:

- **`max-lines`: 300** — file must stay small; forces extraction if someone pastes logic back in.
- **`max-depth`: 3** — limits nested `if`/`for`/`switch` depth so control flow stays flat at the boundary.

Run: `npm run lint`

## Examples

### Allowed in `chat.service.ts`

```ts
if (content.length > LIMITS.MAX_MESSAGE_LENGTH) {
  throw AppError.validation('...');
}
if (!conversation.ai_enabled) {
  throw AppError.conflict('...');
}
return executeProcessChatTurn({ ... });
```

### Not allowed in `chat.service.ts`

```ts
// BAD: appointment / confirmation business logic at the HTTP boundary
if (state.awaiting_confirmation) {
  const decision = classifyConfirmation(content);
  // ...
}

// BAD: intent or field prompts
if (state.current_intent === 'appointment_request') {
  const prompt = getNextFieldPrompt(...);
}

// BAD: inline LLM
const reply = await callLLM(...);
```

### Where to put the “bad” examples instead

- Add or extend a function in `process-chat-turn.ts`, or split into `flow-rules.ts`, `booking.service.ts`, or `response-builder.ts` depending on the concern, then call it from `executeProcessChatTurn`.

## Review checklist (PRs touching `chat.service.ts`)

1. File still under 300 lines and ESLint clean?
2. No new imports from `engine`, `fields`, `prompts`, or `callLLM`?
3. No parsing of `content` beyond token routing already there (`mapGuidedChoiceToken` / `mapCorrectionChoiceToken`)?
4. If a reviewer asks “could this live in `lib/conversation`?” the answer should be yes for anything new.
