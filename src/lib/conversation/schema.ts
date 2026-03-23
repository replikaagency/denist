/**
 * Dental Reception AI — LLM Output Schema
 *
 * Every LLM response MUST conform to this schema. The structured output is
 * parsed with Zod on the server; the `reply` field is what the patient sees,
 * while everything else is metadata consumed by the conversation engine.
 *
 * We use OpenAI's structured-output / JSON-mode so the model is constrained
 * to produce valid JSON matching this shape on every turn.
 */

import { z } from "zod/v4";
import { IntentEnum, UrgencyEnum } from "./taxonomy";

// ---------------------------------------------------------------------------
// Collected patient data (grows across turns)
// ---------------------------------------------------------------------------

export const PatientFieldsSchema = z.object({
  full_name:            z.string().nullable().describe("Patient's full name"),
  phone:                z.string().nullable().describe("Phone number in any format"),
  email:                z.string().nullable().describe("Email address"),
  date_of_birth:        z.string().nullable().describe("Date of birth (any format the patient provides)"),
  new_or_returning:     z.enum(["new", "returning"]).nullable().describe("Whether this is a new or returning patient"),
  insurance_provider:   z.string().nullable().describe("Name of insurance carrier"),
  insurance_member_id:  z.string().nullable().describe("Insurance member/subscriber ID"),
});

export type PatientFields = z.infer<typeof PatientFieldsSchema>;

// ---------------------------------------------------------------------------
// Appointment request details
// ---------------------------------------------------------------------------

export const AppointmentSchema = z.object({
  service_type:         z.string().nullable().describe("E.g. 'cleaning', 'crown', 'extraction', 'emergency exam'"),
  preferred_date:       z.string().nullable().describe("Patient's preferred date (free text, normalized later)"),
  preferred_time:       z.string().nullable().describe("Patient's preferred time or daypart ('morning', '2pm')"),
  preferred_provider:   z.string().nullable().describe("Specific dentist requested, if any"),
  flexibility:          z.enum(["flexible", "somewhat_flexible", "fixed"]).nullable()
                          .describe("How flexible the patient is on date/time"),
});

export type AppointmentDetails = z.infer<typeof AppointmentSchema>;

// ---------------------------------------------------------------------------
// Symptom / clinical report (non-diagnostic — for triage routing only)
// ---------------------------------------------------------------------------

export const SymptomSchema = z.object({
  description:      z.string().nullable().describe("Patient's own words about what they're experiencing"),
  location:         z.string().nullable().describe("Where in the mouth — 'upper left molar', 'front teeth'"),
  duration:         z.string().nullable().describe("How long symptoms have been present"),
  pain_level:       z.int().min(0).max(10).nullable().describe("Self-reported pain on a 0-10 scale"),
  triggers:         z.string().nullable().describe("What makes it worse — 'hot drinks', 'biting down'"),
  prior_treatment:  z.string().nullable().describe("Any recent dental work related to the area"),
});

export type SymptomReport = z.infer<typeof SymptomSchema>;

// ---------------------------------------------------------------------------
// Correction intent — controlled field overwrites
// ---------------------------------------------------------------------------

// Un-namespaced field names accepted from the LLM (appointment + symptom fields only).
// Patient identity fields are intentionally excluded — they are never correctable
// via this mechanism.
export const CorrectionFieldEnum = z.enum([
  // appointment sub-object
  'service_type',
  'preferred_date',
  'preferred_time',
  'preferred_provider',
  'flexibility',
  // symptoms sub-object
  'description',
  'location',
  'duration',
  'pain_level',
  'triggers',
  'prior_treatment',
]);

export type CorrectionField = z.infer<typeof CorrectionFieldEnum>;

// Namespaced field names written to the audit log (domain.field format).
export const CorrectionLogFieldEnum = z.enum([
  'appointment.service_type',
  'appointment.preferred_date',
  'appointment.preferred_time',
  'appointment.preferred_provider',
  'appointment.flexibility',
  'symptoms.description',
  'symptoms.location',
  'symptoms.duration',
  'symptoms.pain_level',
  'symptoms.triggers',
  'symptoms.prior_treatment',
]);

export type CorrectionLogField = z.infer<typeof CorrectionLogFieldEnum>;

const CorrectionLogEntrySchema = z.object({
  field:     CorrectionLogFieldEnum,
  old_value: z.unknown(),
  new_value: z.unknown(),
  timestamp: z.string(),  // ISO 8601
});

export type CorrectionLogEntry = z.infer<typeof CorrectionLogEntrySchema>;

// ---------------------------------------------------------------------------
// Next action the engine should take
// ---------------------------------------------------------------------------

export const NextActionEnum = z.enum([
  "ask_field",          // Ask the patient for a specific missing field
  "offer_appointment",  // Present available slots (requires downstream availability check)
  "confirm_details",    // Read back collected info and ask patient to confirm
  "provide_info",       // Answer an informational question
  "escalate_human",     // Hand off to a human staff member
  "escalate_emergency", // Trigger emergency protocol (call-back within minutes)
  "end_conversation",   // Conversation is complete; no further action needed
  "continue",           // Continue natural conversation (e.g. after greeting)
]);

export type NextAction = z.infer<typeof NextActionEnum>;

// ---------------------------------------------------------------------------
// Optional hybrid booking signals (LLM — backward compatible when omitted)
// ---------------------------------------------------------------------------

/** Coerce a single string from the model into a one-element array (common LLM mistake). */
function coerceHybridStringArray(val: unknown): unknown {
  if (val === null || val === undefined) return undefined;
  if (Array.isArray(val)) return val;
  if (typeof val === 'string' && val.trim()) return [val.trim()];
  return undefined;
}

/** Fields inside LLM `hybrid_booking` (may be null or omitted). */
export const HybridBookingFieldsSchema = z.object({
  booking_mode: z
    .enum(['direct_link', 'callback_request', 'availability_capture'])
    .nullable()
    .optional(),
  service_interest: z.string().nullable().optional(),
  preferred_days: z.preprocess(coerceHybridStringArray, z.array(z.string()).optional()),
  preferred_time_ranges: z.preprocess(coerceHybridStringArray, z.array(z.string()).optional()),
  availability_notes: z.string().nullable().optional(),
  wants_callback: z.boolean().optional(),
  patient_chose_direct_link: z.boolean().optional(),
  patient_declined_direct_link: z.boolean().optional(),
  assistant_should_offer_choice: z.boolean().optional(),
});

export type HybridBookingSignal = z.infer<typeof HybridBookingFieldsSchema>;

// ---------------------------------------------------------------------------
// The full LLM turn output
// ---------------------------------------------------------------------------

export const LLMTurnOutputSchema = z.object({
  // ── Classification ──────────────────────────────────────────────────────
  intent:             IntentEnum.describe("Primary classified intent of the patient's last message"),
  intent_confidence:  z.number().min(0).max(1).describe("Model's confidence in the intent classification (0-1)"),
  secondary_intent:   IntentEnum.nullable().describe("Secondary intent if the message is multi-part"),
  urgency:            UrgencyEnum.describe("Clinical urgency assessment"),
  urgency_reasoning:  z.string().describe("One-sentence justification for the urgency level chosen"),

  // ── Extracted data (only fill in what's new this turn) ──────────────────
  patient_fields:     PatientFieldsSchema.partial().describe("Any new patient info extracted this turn"),
  appointment:        AppointmentSchema.partial().describe("Any new appointment details extracted this turn"),
  symptoms:           SymptomSchema.partial().describe("Any new symptom info extracted this turn"),

  // ── Conversation control ────────────────────────────────────────────────
  next_action:        NextActionEnum.describe("What the engine should do next"),
  missing_fields:     z.array(z.string()).describe("Fields still needed before the next action can complete"),
  escalation_reason:  z.string().nullable().describe("If next_action is escalate_*, explain why"),

  // ── Reply ───────────────────────────────────────────────────────────────
  reply:              z.string().describe("The natural-language message to show the patient"),

  // ── Safety flags ────────────────────────────────────────────────────────
  contains_diagnosis: z.boolean().describe("True if the reply accidentally contains a clinical diagnosis — triggers a rewrite"),
  contains_pricing:   z.boolean().describe("True if the reply states a specific price — triggers a rewrite"),

  // ── Correction intent ────────────────────────────────────────────────────
  is_correction: z.boolean()
    .describe(
      "Set true ONLY when the patient explicitly retracts a previously stated value. " +
      "Required trigger signals: 'no wait', 'mejor', 'I meant', 'actually', 'no, not that'. " +
      "Do NOT set true for a first mention of a field, a clarification, or adding new info. " +
      "Must be false if correction_fields is empty."
    ),
  correction_fields: z.array(CorrectionFieldEnum)
    .describe(
      "Which field names the patient is correcting this turn. " +
      "Must be empty when is_correction is false. " +
      "Only appointment and symptom fields are valid — patient identity fields cannot be corrected via this mechanism."
    ),

  hybrid_booking: HybridBookingFieldsSchema.nullish().describe(
    "Optional hybrid intake: offer direct link vs callback, or capture structured availability. Omit or null if not applicable.",
  ),
}).superRefine((data, ctx) => {
  if (!data.is_correction && data.correction_fields.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ['correction_fields'],
      message: 'correction_fields must be empty when is_correction is false',
    });
  }
});

export type LLMTurnOutput = z.infer<typeof LLMTurnOutputSchema>;

// ---------------------------------------------------------------------------
// Cumulative conversation state (maintained server-side across turns)
// ---------------------------------------------------------------------------

export const ConversationStateSchema = z.object({
  conversation_id:    z.string(),
  turn_count:         z.number(),
  current_intent:     IntentEnum.nullable(),
  current_urgency:    UrgencyEnum,
  patient:            PatientFieldsSchema,
  appointment:        AppointmentSchema,
  symptoms:           SymptomSchema,
  escalated:          z.boolean(),
  escalation_reason:  z.string().nullable(),
  consecutive_low_confidence: z.number().describe("How many turns in a row had confidence < threshold"),
  completed:          z.boolean(),
  // Set to true when the LLM fires `offer_appointment` but the patient is not
  // yet identified. Cleared once the appointment request row is successfully
  // created on a later turn. Uses .default(false) so existing DB records that
  // predate this field parse correctly without migration.
  offer_appointment_pending: z.boolean().default(false),
  // Set to true when an open appointment request exists for this conversation.
  // Synced from DB in chat.service before processTurn so validateFlowAction
  // can block redundant offer_appointment actions without a DB call.
  appointment_request_open: z.boolean().default(false),
  // ── Reschedule flow ──────────────────────────────────────────────────────
  // Tracks which existing appointment_request the patient wants to change.
  // Cleared after reschedule completes or the patient abandons the flow.
  //
  // reschedule_phase:
  //   'idle'                — not rescheduling
  //   'selecting_target'    — 2+ open requests; waiting for patient to pick one
  //   'collecting_new_details' — target locked; LLM gathering new date/time/service
  //
  // All three use .default() so existing DB records parse without a migration.
  reschedule_target_id: z.string().nullable().default(null),
  reschedule_target_summary: z.string().nullable().default(null),
  reschedule_phase: z.enum(['idle', 'selecting_target', 'collecting_new_details']).default('idle'),

  // Explicit confirmation flow — patient must say "sí" before any appointment
  // row is created. Set to true when all required fields are filled but the
  // DB row has not yet been written. Cleared once the patient confirms (row
  // created) or declines (state reset). Uses .default(false) / .default(null)
  // / .default(0) so existing DB records parse without a migration.
  awaiting_confirmation: z.boolean().default(false),
  pending_appointment: AppointmentSchema.nullable().default(null),
  confirmation_attempts: z.number().default(0),
  /** ISO 8601 — set when awaiting_confirmation becomes true; used for 30min expiry (not last_message_at). */
  confirmation_prompt_at: z.string().nullable().default(null),
  // True when an active hybrid_bookings row exists for this conversation (synced from DB each turn).
  hybrid_booking_open: z.boolean().default(false),
  // True after the two-way self-service vs manual booking offer was appended to a reply (no DB row).
  self_service_booking_offer_shown: z.boolean().default(false),
  // Audit and operational metadata. Uses .loose() so unknown keys present in
  // existing DB records are preserved on parse/re-save without a migration.
  // correction_log is expected to remain small (single-digit entries per
  // conversation). Derived metrics (correction_count, last_correction_at,
  // too_many_corrections) are computed at write time in applyValidatedCorrections
  // so they are always consistent with correction_log and available to any
  // reader without recomputation.
  metadata: z
    .object({
      correction_log:       z.array(CorrectionLogEntrySchema).default([]),
      correction_count:     z.number().default(0),
      last_correction_at:   z.string().nullable().default(null),
      too_many_corrections: z.boolean().default(false),
    })
    .loose()
    .default({
      correction_log:       [],
      correction_count:     0,
      last_correction_at:   null,
      too_many_corrections: false,
    }),
});

export type ConversationState = z.infer<typeof ConversationStateSchema>;

// ---------------------------------------------------------------------------
// Helper: blank initial state
// ---------------------------------------------------------------------------

export function createInitialState(conversationId: string): ConversationState {
  return {
    conversation_id: conversationId,
    turn_count: 0,
    current_intent: null,
    current_urgency: "informational",
    patient: {
      full_name: null,
      phone: null,
      email: null,
      date_of_birth: null,
      new_or_returning: null,
      insurance_provider: null,
      insurance_member_id: null,
    },
    appointment: {
      service_type: null,
      preferred_date: null,
      preferred_time: null,
      preferred_provider: null,
      flexibility: null,
    },
    symptoms: {
      description: null,
      location: null,
      duration: null,
      pain_level: null,
      triggers: null,
      prior_treatment: null,
    },
    escalated: false,
    escalation_reason: null,
    consecutive_low_confidence: 0,
    completed: false,
    offer_appointment_pending: false,
    appointment_request_open: false,
    reschedule_target_id: null,
    reschedule_target_summary: null,
    reschedule_phase: 'idle',
    awaiting_confirmation: false,
    pending_appointment: null,
    confirmation_attempts: 0,
    confirmation_prompt_at: null,
    hybrid_booking_open: false,
    self_service_booking_offer_shown: false,
    metadata: { correction_log: [], correction_count: 0, last_correction_at: null, too_many_corrections: false },
  };
}
