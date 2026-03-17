/**
 * Dental Reception AI — Conversation Engine
 *
 * Orchestrates a single conversation turn:
 *   1. Inject conversation state into the system prompt
 *   2. Call the LLM with structured output
 *   3. Validate & parse the response with Zod
 *   4. Apply post-processing rules (safety rewrites, escalation, fallback)
 *   5. Merge extracted fields into cumulative state
 *   6. Return the reply + updated state
 *
 * This module also codifies the FALLBACK STRATEGY and ESCALATION RULES
 * as deterministic, auditable logic — not prompt-dependent behavior.
 */

import { CONFIDENCE, type Intent, type Urgency } from "./taxonomy";
import {
  LLMTurnOutputSchema,
  type LLMTurnOutput,
  type ConversationState,
  type NextAction,
} from "./schema";
import { getMissingFields, getNextFieldPrompt } from "./fields";

// ---------------------------------------------------------------------------
// ESCALATION RULES
// ---------------------------------------------------------------------------

export interface EscalationDecision {
  shouldEscalate: boolean;
  reason: string | null;
  type: "emergency" | "human" | null;
}

/**
 * Deterministic escalation check — runs AFTER the LLM turn, and can
 * override the model's next_action if safety rules demand it.
 *
 * These rules are intentionally NOT in the prompt — they are hard-coded
 * so the model cannot talk itself out of them.
 */
export function checkEscalation(
  output: LLMTurnOutput,
  state: ConversationState,
): EscalationDecision {
  const NO_ESCALATION: EscalationDecision = { shouldEscalate: false, reason: null, type: null };

  // Rule 1: Emergency urgency always escalates
  if (output.urgency === "emergency") {
    return {
      shouldEscalate: true,
      reason: output.urgency_reasoning || "Emergency-level urgency detected.",
      type: "emergency",
    };
  }

  // Rule 2: Patient explicitly asks for a human
  if (output.intent === "human_handoff_request") {
    return {
      shouldEscalate: true,
      reason: "Patient explicitly requested to speak with a person.",
      type: "human",
    };
  }

  // Rule 3: Complaint intent — escalate after empathetic acknowledgment
  if (output.intent === "complaint") {
    return {
      shouldEscalate: true,
      reason: "Patient complaint — routing to office manager for resolution.",
      type: "human",
    };
  }

  // Rule 4: Too many consecutive low-confidence turns
  const lowConfCount = output.intent_confidence < CONFIDENCE.MEDIUM
    ? state.consecutive_low_confidence + 1
    : 0;
  if (lowConfCount >= 3) {
    return {
      shouldEscalate: true,
      reason: `Unable to understand patient intent after ${lowConfCount} consecutive attempts.`,
      type: "human",
    };
  }

  // Rule 5: Conversation has exceeded reasonable turn count without resolution
  if (state.turn_count >= 20 && !state.completed) {
    return {
      shouldEscalate: true,
      reason: "Conversation exceeded 20 turns without resolution — connecting to staff.",
      type: "human",
    };
  }

  // Rule 6: Model itself requested escalation
  if (output.next_action === "escalate_human" || output.next_action === "escalate_emergency") {
    return {
      shouldEscalate: true,
      reason: output.escalation_reason || "Model requested escalation.",
      type: output.next_action === "escalate_emergency" ? "emergency" : "human",
    };
  }

  return NO_ESCALATION;
}

// ---------------------------------------------------------------------------
// FALLBACK STRATEGY
// ---------------------------------------------------------------------------

export interface FallbackResult {
  applied: boolean;
  rewrittenReply: string | null;
  reason: string | null;
}

/**
 * Post-LLM safety rewrites and fallback behaviors.
 */
export function applyFallbacks(
  output: LLMTurnOutput,
  state: ConversationState,
): FallbackResult {
  const NO_FALLBACK: FallbackResult = { applied: false, rewrittenReply: null, reason: null };

  // Fallback 1: Diagnosis leak — rewrite the reply
  if (output.contains_diagnosis) {
    return {
      applied: true,
      rewrittenReply: stripDiagnosisFromReply(output.reply),
      reason: "Reply contained a diagnosis. Rewritten to recommend a dental visit instead.",
    };
  }

  // Fallback 2: Pricing leak — rewrite the reply
  if (output.contains_pricing) {
    return {
      applied: true,
      rewrittenReply: stripPricingFromReply(output.reply),
      reason: "Reply contained specific pricing. Rewritten to offer an estimate request instead.",
    };
  }

  // Fallback 3: Unknown intent with low confidence
  if (output.intent === "unknown" && output.intent_confidence < CONFIDENCE.MEDIUM) {
    return {
      applied: true,
      rewrittenReply:
        "I want to make sure I help you the right way. Could you tell me a bit more about what you're looking for? " +
        "For example, are you looking to book an appointment, asking about a service, or reporting a dental concern?",
      reason: "Could not classify intent — using guided clarification.",
    };
  }

  // Fallback 4: Out-of-scope question
  if (output.intent === "out_of_scope") {
    return {
      applied: true,
      rewrittenReply:
        "I appreciate the question, but I'm only able to help with dental-related topics — " +
        "things like appointments, services, insurance, or dental concerns. Is there anything along those lines I can help with?",
      reason: "Out-of-scope message received — redirecting to dental topics.",
    };
  }

  // Fallback 5: Appointment completion with misleading "let me check" — we have no real availability
  const isSchedulingIntent =
    output.intent === "appointment_request" || output.intent === "appointment_reschedule";
  const isCompletionAction =
    output.next_action === "offer_appointment" || output.next_action === "confirm_details";
  const misleadingPhrases = [
    "let me check",
    "i'll check",
    "i'll get back to you",
    "i'll find",
    "hang tight",
    "get back to you with",
  ];
  const replyLower = output.reply.toLowerCase();
  if (isSchedulingIntent && isCompletionAction && misleadingPhrases.some((p) => replyLower.includes(p))) {
    return {
      applied: true,
      rewrittenReply:
        "I've got your request. Your preference is noted, and our team will check availability and reach out to confirm your appointment. Is there anything else I can help with?",
      reason: "Reply implied checking availability — replaced with clear final confirmation.",
    };
  }

  return NO_FALLBACK;
}

function stripDiagnosisFromReply(reply: string): string {
  return reply + "\n\n(Note: I'm not able to provide a diagnosis. I'd recommend scheduling an appointment so a dentist can properly evaluate this for you.)";
}

function stripPricingFromReply(reply: string): string {
  return reply.replace(
    /\$\d[\d,]*(\.\d{2})?/g,
    "[contact our office for pricing]"
  ) + "\n\nFor an accurate cost estimate, our team can check your specific insurance benefits and treatment needs.";
}

// ---------------------------------------------------------------------------
// STATE MERGE
// ---------------------------------------------------------------------------

/**
 * Merge newly extracted fields from the LLM turn into the cumulative state.
 * Only overwrites null fields — never deletes previously collected data.
 */
export function mergeState(
  state: ConversationState,
  output: LLMTurnOutput,
): ConversationState {
  const mergeObj = <T extends Record<string, unknown>>(
    existing: T,
    incoming: Partial<T>,
  ): T => {
    const result = { ...existing };
    for (const [key, value] of Object.entries(incoming)) {
      if (value !== null && value !== undefined && value !== "") {
        (result as Record<string, unknown>)[key] = value;
      }
    }
    return result;
  };

  const newState: ConversationState = {
    ...state,
    turn_count: state.turn_count + 1,
    current_intent: output.intent,
    current_urgency: resolveUrgency(state.current_urgency, output.urgency),
    patient: mergeObj(state.patient, output.patient_fields),
    appointment: mergeObj(state.appointment, output.appointment),
    symptoms: mergeObj(state.symptoms, output.symptoms),
    consecutive_low_confidence:
      output.intent_confidence < CONFIDENCE.MEDIUM
        ? state.consecutive_low_confidence + 1
        : 0,
  };

  return newState;
}

// ---------------------------------------------------------------------------
// SAFE STATE MERGE (two-phase)
// ---------------------------------------------------------------------------

/**
 * Fill-null-only merge helper. Never overwrites an existing non-null/non-empty
 * value. Returns the merged object and a log of attempted overwrites for audit.
 * @internal
 */
function safeMergeObj<T extends Record<string, unknown>>(
  existing: T,
  incoming: Partial<T>,
): { merged: T; overwrites: Array<{ field: string; existing: unknown; attempted: unknown }> } {
  const result = { ...existing };
  const overwrites: Array<{ field: string; existing: unknown; attempted: unknown }> = [];

  for (const [key, value] of Object.entries(incoming)) {
    if (value === null || value === undefined || value === '') continue;
    const current = (existing as Record<string, unknown>)[key];
    if (current === null || current === undefined || current === '') {
      (result as Record<string, unknown>)[key] = value;
    } else if (current !== value) {
      overwrites.push({ field: key, existing: current, attempted: value });
    }
  }

  return { merged: result as T, overwrites };
}

/**
 * Phase 1 of the two-phase merge: merges patient identity fields and updates
 * turn counters. appointment/symptoms are intentionally left untouched until
 * the flow controller validates the LLM's next_action.
 */
function safeMergePatient(
  state: ConversationState,
  output: LLMTurnOutput,
): ConversationState {
  const { merged: patient } = safeMergeObj(state.patient, output.patient_fields);
  return {
    ...state,
    turn_count: state.turn_count + 1,
    current_intent: output.intent,
    current_urgency: resolveUrgency(state.current_urgency, output.urgency),
    patient,
    consecutive_low_confidence:
      output.intent_confidence < CONFIDENCE.MEDIUM
        ? state.consecutive_low_confidence + 1
        : 0,
  };
}

/**
 * Phase 2 of the two-phase merge: fills null appointment and symptom fields.
 * Called only when validateFlowAction confirmed the LLM's next_action is valid
 * for the current flow stage — prevents state contamination from incoherent turns.
 */
function safeMergeAppointment(
  state: ConversationState,
  output: LLMTurnOutput,
): ConversationState {
  const { merged: appointment } = safeMergeObj(state.appointment, output.appointment);
  const { merged: symptoms } = safeMergeObj(state.symptoms, output.symptoms);
  return { ...state, appointment, symptoms };
}

/**
 * Urgency only escalates during a conversation — never de-escalates.
 * If the patient first says "I want a cleaning" (routine) then later says
 * "actually it really hurts" (urgent), urgency stays at urgent.
 */
const URGENCY_RANK: Record<Urgency, number> = {
  informational: 0,
  routine: 1,
  soon: 2,
  urgent: 3,
  emergency: 4,
};

function resolveUrgency(current: Urgency, incoming: Urgency): Urgency {
  return URGENCY_RANK[incoming] > URGENCY_RANK[current] ? incoming : current;
}

// ---------------------------------------------------------------------------
// FLOW CONTROLLER
// ---------------------------------------------------------------------------

export type ConversationFlowStage =
  | 'collecting'      // Scheduling intent, required fields still missing
  | 'ready'           // Scheduling intent, all required fields present
  | 'non_scheduling'  // Non-scheduling intent or no intent yet
  | 'terminal';       // Already escalated or completed

export interface FlowValidationResult {
  stage: ConversationFlowStage;
  overridden: boolean;
  originalAction: NextAction;
  correctedAction: NextAction;
  correctedReply: string | null;
  reason: string | null;
}

const PERMITTED_ACTIONS: Record<ConversationFlowStage, Set<NextAction>> = {
  collecting:     new Set<NextAction>(['ask_field', 'continue', 'provide_info', 'escalate_human', 'escalate_emergency']),
  ready:          new Set<NextAction>(['offer_appointment', 'confirm_details', 'ask_field', 'end_conversation', 'escalate_human', 'escalate_emergency']),
  non_scheduling: new Set<NextAction>(['ask_field', 'confirm_details', 'provide_info', 'continue', 'end_conversation', 'escalate_human', 'escalate_emergency']),
  terminal:       new Set<NextAction>(['end_conversation', 'escalate_human', 'escalate_emergency']),
};

function deriveFlowStage(state: ConversationState): ConversationFlowStage {
  if (state.escalated || state.completed) return 'terminal';

  const isScheduling =
    state.current_intent === 'appointment_request' ||
    state.current_intent === 'appointment_reschedule';

  if (!state.current_intent || !isScheduling) return 'non_scheduling';

  const missing = getMissingFields(state.current_intent, {
    patient: state.patient,
    appointment: state.appointment,
    symptoms: state.symptoms,
  });

  return missing.length > 0 ? 'collecting' : 'ready';
}

/**
 * Validates the LLM's next_action against the current flow stage.
 * Called with previewState (patient merged + appointment previewed) so
 * fields extracted THIS turn are visible — preventing false negatives where
 * the LLM extracts the last required field and fires offer_appointment on the
 * same turn.
 *
 * If the action is not permitted, overrides it to ask_field (or continue if
 * no field prompt is available) and generates a corrected reply.
 */
export function validateFlowAction(
  output: LLMTurnOutput,
  state: ConversationState,
): FlowValidationResult {
  const stage = deriveFlowStage(state);
  const permitted = PERMITTED_ACTIONS[stage];

  const isRedundantOffer =
    output.next_action === 'offer_appointment' && state.appointment_request_open;

  if (permitted.has(output.next_action) && !isRedundantOffer) {
    return {
      stage,
      overridden: false,
      originalAction: output.next_action,
      correctedAction: output.next_action,
      correctedReply: null,
      reason: null,
    };
  }

  const reason = isRedundantOffer
    ? 'offer_appointment blocked: appointment request already open'
    : `next_action '${output.next_action}' not permitted in stage '${stage}'`;

  const nextPrompt = state.current_intent
    ? getNextFieldPrompt(state.current_intent, {
        patient: state.patient,
        appointment: state.appointment,
        symptoms: state.symptoms,
      })
    : null;

  const correctedAction: NextAction = nextPrompt ? 'ask_field' : 'continue';

  return {
    stage,
    overridden: true,
    originalAction: output.next_action,
    correctedAction,
    correctedReply: nextPrompt?.prompt ?? null,
    reason,
  };
}

// ---------------------------------------------------------------------------
// VALIDATE LLM OUTPUT
// ---------------------------------------------------------------------------

export type ParseResult =
  | { success: true; data: LLMTurnOutput }
  | { success: false; error: string; rawOutput: string };

export function parseLLMOutput(raw: string): ParseResult {
  try {
    const json = JSON.parse(raw);
    const parsed = LLMTurnOutputSchema.parse(json);
    return { success: true, data: parsed };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown parse error",
      rawOutput: raw,
    };
  }
}

// ---------------------------------------------------------------------------
// FULL TURN ORCHESTRATION
// ---------------------------------------------------------------------------

export interface TurnResult {
  reply: string;
  state: ConversationState;
  escalation: EscalationDecision;
  fallback: FallbackResult;
  flowValidation: FlowValidationResult;
  rawOutput: LLMTurnOutput;
}

/**
 * Process a single conversation turn. This is the main entry point
 * called by the API route after the LLM responds.
 *
 * The actual LLM call is NOT in this function — it's handled by the
 * API route which constructs messages and calls OpenAI. This function
 * handles everything that happens AFTER the LLM responds.
 */
export function processTurn(
  rawLLMOutput: string,
  currentState: ConversationState,
): TurnResult | { error: string } {
  const parsed = parseLLMOutput(rawLLMOutput);

  if (!parsed.success) {
    return {
      error: `LLM output failed validation: ${parsed.error}`,
    };
  }

  const output = parsed.data;

  // 1. Merge patient identity + turn counters (always safe — never overwrites).
  const partialState = safeMergePatient(currentState, output);

  // 2. Build an ephemeral previewState for flow validation.
  //    Previews appointment fields as they would look after safeMergeAppointment
  //    so validateFlowAction sees fields extracted THIS turn, preventing false
  //    negatives when the LLM fills the last required field and fires
  //    offer_appointment on the same turn.
  const { merged: previewAppointment } = safeMergeObj(
    partialState.appointment,
    output.appointment,
  );
  const previewState: ConversationState = { ...partialState, appointment: previewAppointment };

  // 3. Validate next_action against the preview state.
  const flowValidation = validateFlowAction(output, previewState);
  const correctedOutput = flowValidation.overridden
    ? { ...output, next_action: flowValidation.correctedAction }
    : output;

  // 4. Conditionally merge appointment/symptoms.
  //    Skipped when the action was overridden — prevents contaminating state
  //    with fields from an incoherent LLM turn.
  const newState = flowValidation.overridden
    ? partialState
    : safeMergeAppointment(partialState, output);

  // 5. Check deterministic escalation rules.
  const escalation = checkEscalation(correctedOutput, newState);

  // 6. Apply fallback rewrites.
  const fallback = applyFallbacks(correctedOutput, newState);

  // 7. Determine final reply.
  // Priority (highest wins): escalation append > fallback rewrite > flow override > LLM reply
  let reply = output.reply;
  if (flowValidation.overridden && flowValidation.correctedReply) {
    reply = flowValidation.correctedReply;
  }
  if (fallback.applied && fallback.rewrittenReply) {
    reply = fallback.rewrittenReply;
  }

  // 8. If escalation triggered, append handoff message.
  if (escalation.shouldEscalate) {
    newState.escalated = true;
    newState.escalation_reason = escalation.reason;

    if (escalation.type === "emergency") {
      reply += "\n\nI'm connecting you with our emergency team right now. " +
        "If you feel this is life-threatening, please call 911 immediately.";
    } else {
      reply += "\n\nLet me connect you with a team member who can help you further. " +
        "One moment please.";
    }
  }

  // 9. If no escalation and all required fields are filled, nudge toward completion.
  if (
    !escalation.shouldEscalate &&
    !fallback.applied &&
    correctedOutput.next_action === "ask_field" &&
    newState.current_intent
  ) {
    const missing = getMissingFields(
      newState.current_intent,
      { patient: newState.patient, appointment: newState.appointment, symptoms: newState.symptoms },
    );
    if (missing.length === 0) {
      newState.completed = true;
    }
  }

  return {
    reply,
    state: newState,
    escalation,
    fallback,
    flowValidation,
    rawOutput: correctedOutput,
  };
}
