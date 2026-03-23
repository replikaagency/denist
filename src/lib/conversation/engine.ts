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

/** Intents where rewriting a model "end_conversation" could mask real closure/handoff. */
const NO_END_CONVERSATION_OVERRIDE_INTENTS = new Set<Intent>([
  "complaint",
  "human_handoff_request",
  "emergency_report",
  "symptom_report",
  "post_treatment_concern",
]);
import {
  LLMTurnOutputSchema,
  type LLMTurnOutput,
  type ConversationState,
  type NextAction,
  type CorrectionField,
  type CorrectionLogEntry,
  type CorrectionLogField,
} from "./schema";
import { getMissingFields, getNextFieldPrompt } from "./fields";
import { LIMITS } from "@/config/constants";
import { DECLINE_OFFER_FOLLOWUP_REPLY_ES, isPlainDecline } from "./confirmation";

// ---------------------------------------------------------------------------
// ESCALATION RULES
// ---------------------------------------------------------------------------

export interface EscalationDecision {
  shouldEscalate: boolean;
  reason: string | null;
  type: "emergency" | "urgent" | "human" | null;
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
  patientUtterance?: string,
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

  // Rule 1b: Urgent urgency escalates to staff (not emergency services)
  if (output.urgency === "urgent") {
    return {
      shouldEscalate: true,
      reason: output.urgency_reasoning || "Urgent-level urgency detected.",
      type: "urgent",
    };
  }

  // Rule 1c: post_treatment_concern with alarm symptoms escalates as urgent
  if (
    output.intent === "post_treatment_concern" &&
    /sangr[ao]|fiebre|hinchaz[oó]n|infecci[oó]n/i.test(output.symptoms?.description ?? "")
  ) {
    return {
      shouldEscalate: true,
      reason: "Post-treatment concern with alarm symptom detected.",
      type: "urgent",
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
  if (state.turn_count >= LIMITS.MAX_TURNS_BEFORE_ESCALATION && !state.completed) {
    return {
      shouldEscalate: true,
      reason: `Conversation exceeded ${LIMITS.MAX_TURNS_BEFORE_ESCALATION} turns without resolution — connecting to staff.`,
      type: "human",
    };
  }

  // Rule 6: Model itself requested escalation — except normal declines of an offer,
  // which must not hand off (LLM often mis-fires escalate_human on a bare "no").
  if (output.next_action === "escalate_human" || output.next_action === "escalate_emergency") {
    if (output.next_action === "escalate_emergency") {
      return {
        shouldEscalate: true,
        reason: output.escalation_reason || "Model requested escalation.",
        type: "emergency",
      };
    }
    const plainNo =
      output.intent === "denial" ||
      (patientUtterance != null && patientUtterance.trim() !== "" && isPlainDecline(patientUtterance));
    if (plainNo) {
      return NO_ESCALATION;
    }
    return {
      shouldEscalate: true,
      reason: output.escalation_reason || "Model requested escalation.",
      type: "human",
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
 * Builds a natural-language summary of the data collected so far.
 * Omits any field that is missing — never mentions gaps to the patient.
 */
function buildCompletionSummary(state: ConversationState): string {
  const parts: string[] = [];
  if (state.patient.full_name) parts.push(state.patient.full_name);
  if (state.patient.phone)     parts.push(state.patient.phone);
  const date = state.appointment.preferred_date;
  const time = state.appointment.preferred_time;
  const timeLabel =
    time === "morning"   ? "mañana" :
    time === "afternoon" ? "tarde"  :
    time ?? null;
  if (date && timeLabel) parts.push(`${date} por la ${timeLabel}`);
  else if (date)         parts.push(date);
  else if (timeLabel)    parts.push(`por la ${timeLabel}`);

  const summary = parts.length > 0 ? `Te lo dejo anotado: ${parts.join(", ")}. ` : "";
  return `${summary}El equipo se pondrá en contacto contigo para confirmar la disponibilidad. ¿Hay algo más en lo que pueda ayudarte?`;
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
        "Quiero asegurarme de ayudarte bien. ¿Podrías contarme un poco más sobre lo que necesitas? " +
        "Por ejemplo, ¿quieres enviar una solicitud de cita, tienes alguna pregunta sobre nuestros servicios o tienes alguna molestia dental?",
      reason: "Could not classify intent — using guided clarification.",
    };
  }

  // Fallback 4: Out-of-scope question
  if (output.intent === "out_of_scope") {
    return {
      applied: true,
      rewrittenReply:
        "Te agradezco la pregunta, pero solo puedo ayudarte con temas relacionados con la salud dental — " +
        "citas, servicios, seguros o consultas dentales. ¿Hay algo en ese sentido en lo que pueda ayudarte?",
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
    "déjame comprobar",
    "voy a comprobar",
    "te aviso",
    "busco un hueco",
    "miro la disponibilidad",
    "compruebo",
  ];
  const replyLower = output.reply.toLowerCase();
  if (isSchedulingIntent && isCompletionAction && misleadingPhrases.some((p) => replyLower.includes(p))) {
    return {
      applied: true,
      rewrittenReply: buildCompletionSummary(state),
      reason: "Reply implied checking availability — replaced with clear final confirmation.",
    };
  }

  // Fallback 6: Empty / whitespace reply — should never reach production but
  // guard here so the patient always gets a usable response.
  if (!output.reply || output.reply.trim() === '') {
    return {
      applied: true,
      rewrittenReply:
        'Lo siento, algo ha ido mal con mi respuesta. ¿Podrías repetir tu pregunta de otra forma?',
      reason: 'LLM returned an empty reply — replaced with a safe fallback.',
    };
  }

  return NO_FALLBACK;
}

function stripDiagnosisFromReply(_reply: string): string {
  const phone = process.env.CLINIC_PHONE ?? "";
  const phoneClause = phone ? ` al ${phone}` : "";
  return (
    `No estoy en posición de valorar síntomas médicos. ` +
    `Para cualquier consulta clínica, contacta directamente con la clínica${phoneClause}. ` +
    `¿Hay algo más en lo que pueda ayudarte, como solicitar una cita?`
  );
}

function stripPricingFromReply(reply: string): string {
  return reply.replace(
    /[\$€]\d[\d.,]*(\.\d{2})?/g,
    "[consulta el precio con la clínica]"
  ) + "\n\nPara un presupuesto exacto, nuestro equipo puede revisar tu cobertura de seguro y las necesidades de tratamiento.";
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
// CONTROLLED CORRECTION OVERWRITES
// ---------------------------------------------------------------------------

/**
 * Conversations with this many or more corrections are flagged for review.
 * Exported so consumers (e.g. a debug route) can display the threshold
 * alongside the metric without hardcoding it elsewhere.
 */
export const CORRECTION_ALERT_THRESHOLD = 3;

/**
 * Explicit ownership sets — the single source of truth for routing a
 * CorrectionField to its sub-object in ConversationState.
 * Together they must cover all values of CorrectionFieldEnum exactly.
 * Runtime object shape (`field in state.appointment`) is never consulted.
 */
const APPOINTMENT_CORRECTION_FIELDS = new Set<CorrectionField>([
  'service_type',
  'preferred_date',
  'preferred_time',
  'preferred_provider',
  'flexibility',
]);

const SYMPTOM_CORRECTION_FIELDS = new Set<CorrectionField>([
  'description',
  'location',
  'duration',
  'pain_level',
  'triggers',
  'prior_treatment',
]);

/**
 * Validates a correction value before it can overwrite existing state.
 * Returns the validated value, or null if the value should be rejected.
 *
 * State-layer contract: preferred_date and preferred_time are stored as raw
 * strings (patient free-text). Normalization to ISO date / TimeOfDay enum
 * happens at createRequest time, not here. Validators must match that contract.
 */
function validateCorrectionValue(field: CorrectionField, value: unknown): unknown {
  if (value === null || value === undefined || value === '') return null;

  switch (field) {
    case 'preferred_date':
    case 'preferred_time':
    case 'service_type':
    case 'preferred_provider':
    case 'description':
    case 'location':
    case 'duration':
    case 'triggers':
    case 'prior_treatment': {
      // Free-text fields: non-empty string, capped at 200 chars
      const s = String(value).trim();
      return s.length > 0 && s.length <= 200 ? s : null;
    }
    case 'flexibility': {
      const valid = ['flexible', 'somewhat_flexible', 'fixed'];
      return valid.includes(String(value)) ? value : null;
    }
    case 'pain_level': {
      const n = Number(value);
      return Number.isInteger(n) && n >= 0 && n <= 10 ? n : null;
    }
  }
}

/**
 * Applies validated correction overwrites to appointment/symptom fields.
 * Runs unconditionally — independent of whether next_action was overridden.
 * Only activates when output.is_correction === true and correction_fields is
 * non-empty. Appends an audit entry to metadata.correction_log for every
 * overwrite that lands.
 */
function applyValidatedCorrections(
  state: ConversationState,
  output: LLMTurnOutput,
): ConversationState {
  if (!output.is_correction || output.correction_fields.length === 0) {
    return state;
  }

  const appointment = { ...state.appointment };
  const symptoms    = { ...state.symptoms };
  const newLogEntries: CorrectionLogEntry[] = [];

  for (const field of output.correction_fields) {
    const isAppointment = APPOINTMENT_CORRECTION_FIELDS.has(field);
    const isSymptom     = SYMPTOM_CORRECTION_FIELDS.has(field);

    // Belt-and-suspenders: every CorrectionField belongs to exactly one set.
    // In practice unreachable — CorrectionFieldEnum guarantees full coverage.
    if (!isAppointment && !isSymptom) continue;

    // Resolve incoming value from the correct sub-object.
    const incoming = isAppointment
      ? (output.appointment as Record<string, unknown>)?.[field]
      : (output.symptoms    as Record<string, unknown>)?.[field];

    if (incoming === null || incoming === undefined || incoming === '') continue;

    // Resolve current value from the working copy (not original state, in case
    // two corrections in the same turn target the same field).
    const current = isAppointment
      ? (appointment as Record<string, unknown>)[field]
      : (symptoms    as Record<string, unknown>)[field];

    const validated = validateCorrectionValue(field, incoming);
    if (validated === null) continue;    // failed validation — silent skip
    if (validated === current) continue; // identical value — no-op

    if (isAppointment) {
      (appointment as Record<string, unknown>)[field] = validated;
    } else {
      (symptoms as Record<string, unknown>)[field] = validated;
    }

    // The cast is safe: field ∈ APPOINTMENT_CORRECTION_FIELDS ∪ SYMPTOM_CORRECTION_FIELDS,
    // which maps 1:1 to CorrectionLogFieldEnum values.
    const logField = `${isAppointment ? 'appointment' : 'symptoms'}.${field}` as CorrectionLogField;

    newLogEntries.push({
      field:     logField,
      old_value: current,
      new_value: validated,
      timestamp: new Date().toISOString(),
    });
  }

  if (newLogEntries.length === 0) return state;

  // Build the final log once so derived metrics are computed from the same
  // array reference. correction_log is expected to remain small (single-digit
  // entries per conversation); metrics are derived at write time intentionally
  // so any reader gets them for free without recomputation.
  const finalLog = [
    ...(state.metadata?.correction_log ?? []),
    ...newLogEntries,
  ];

  return {
    ...state,
    appointment,
    symptoms,
    metadata: {
      ...state.metadata,
      correction_log:       finalLog,
      correction_count:     finalLog.length,
      last_correction_at:   finalLog[finalLog.length - 1].timestamp,
      too_many_corrections: finalLog.length >= CORRECTION_ALERT_THRESHOLD,
    },
  };
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

/** Recover JSON when the model wraps content or adds leading/trailing noise. */
function tryParseJsonObject(raw: string): unknown | null {
  const trimmed = raw.trim();
  const attempts: string[] = [trimmed];
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/m);
  if (fence?.[1]) attempts.unshift(fence[1].trim());
  const i = trimmed.indexOf('{');
  const j = trimmed.lastIndexOf('}');
  if (i >= 0 && j > i) attempts.push(trimmed.slice(i, j + 1));
  for (const s of attempts) {
    try {
      return JSON.parse(s);
    } catch {
      /* try next */
    }
  }
  return null;
}

export function parseLLMOutput(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw.trim());
  } catch {
    const recovered = tryParseJsonObject(raw);
    if (recovered === null) {
      return {
        success: false,
        error: "Invalid JSON",
        rawOutput: raw,
      };
    }
    json = recovered;
  }
  try {
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
  patientUtterance?: string,
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
  // Plain "no" / "no gracias" is unambiguous — reset low-confidence streak so Rule 4
  // does not escalate after unrelated unclear turns.
  const adjustedPartial =
    patientUtterance && isPlainDecline(patientUtterance)
      ? { ...partialState, consecutive_low_confidence: 0 }
      : partialState;

  // 2. Build an ephemeral previewState for flow validation.
  //    Previews appointment fields as they would look after safeMergeAppointment
  //    so validateFlowAction sees fields extracted THIS turn, preventing false
  //    negatives when the LLM fills the last required field and fires
  //    offer_appointment on the same turn.
  const { merged: previewAppointment } = safeMergeObj(
    adjustedPartial.appointment,
    output.appointment,
  );
  const previewState: ConversationState = { ...adjustedPartial, appointment: previewAppointment };

  // 3. Validate next_action against the preview state.
  const flowValidation = validateFlowAction(output, previewState);
  const correctedOutput = flowValidation.overridden
    ? { ...output, next_action: flowValidation.correctedAction }
    : output;

  // 4. Apply validated corrections UNCONDITIONALLY.
  //    Explicit corrections are independent of flow validity: if the patient
  //    clearly retracts a previous value ("no, Friday instead") the data must
  //    land even when next_action was overridden for an unrelated reason.
  const correctedState = applyValidatedCorrections(adjustedPartial, output);

  // 5. Conditionally apply normal fill-null merge.
  //    Blocked when the action was overridden — prevents contaminating state
  //    with fields from an incoherent LLM turn. Corrections already landed above.
  const newState = flowValidation.overridden
    ? correctedState
    : safeMergeAppointment(correctedState, output);

  // 5. Check deterministic escalation rules.
  const escalation = checkEscalation(correctedOutput, newState, patientUtterance);

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
      reply += "\n\nEstoy contactando ahora mismo con nuestro equipo de urgencias. " +
        "Si crees que es una emergencia con riesgo vital, llama al 112 inmediatamente.";
    } else if (escalation.type === "urgent") {
      const emergencyPhone = process.env.CLINIC_EMERGENCY_PHONE ?? "";
      const phoneClause = emergencyPhone
        ? ` Si el dolor es muy intenso, puedes llamar directamente al ${emergencyPhone}.`
        : "";
      reply += `\n\nEntiendo que tienes una molestia urgente. Voy a avisar al equipo de la clínica para que te contacten lo antes posible.${phoneClause}`;
    } else {
      reply += "\n\nDéjame conectarte con un miembro de nuestro equipo que podrá ayudarte mejor. " +
        "Un momento, por favor.";
    }
  }

  // 9. If no escalation and all required fields are filled, nudge toward completion.
  //    Guard: only fire for scheduling intents. For intents with no FIELD_REQUIREMENTS
  //    entry (e.g. clinic_info, gratitude), getMissingFields returns [] unconditionally,
  //    which would falsely set completed=true and lock the conversation into terminal stage.
  const isSchedulingIntentForCompletion =
    newState.current_intent === "appointment_request" ||
    newState.current_intent === "appointment_reschedule";

  if (
    isSchedulingIntentForCompletion &&
    newState.current_intent &&        // narrows Intent | null → Intent for getMissingFields
    !escalation.shouldEscalate &&
    !fallback.applied &&
    correctedOutput.next_action === "ask_field"
  ) {
    const missing = getMissingFields(
      newState.current_intent,
      { patient: newState.patient, appointment: newState.appointment, symptoms: newState.symptoms },
    );
    if (missing.length === 0) {
      newState.completed = true;
    }
  }

  // Completion check for appointment_cancel.
  // Separate block because cancel lives in non_scheduling stage and uses
  // confirm_details (not offer_appointment) as its terminal action.
  if (
    newState.current_intent === "appointment_cancel" &&
    !escalation.shouldEscalate &&
    !fallback.applied &&
    (correctedOutput.next_action === "confirm_details" ||
      correctedOutput.next_action === "ask_field")
  ) {
    const missing = getMissingFields(
      "appointment_cancel",
      { patient: newState.patient, appointment: newState.appointment, symptoms: newState.symptoms },
    );
    if (missing.length === 0) {
      newState.completed = true;
    }
  }

  // Plain decline must not close the chat: model sometimes sets end_conversation on "no".
  let finalRawOutput = correctedOutput;
  if (
    patientUtterance &&
    isPlainDecline(patientUtterance) &&
    !escalation.shouldEscalate &&
    correctedOutput.next_action === "end_conversation" &&
    !NO_END_CONVERSATION_OVERRIDE_INTENTS.has(correctedOutput.intent)
  ) {
    finalRawOutput = { ...correctedOutput, next_action: "continue" };
    reply = DECLINE_OFFER_FOLLOWUP_REPLY_ES;
  }

  return {
    reply,
    state: newState,
    escalation,
    fallback,
    flowValidation,
    rawOutput: finalRawOutput,
  };
}
