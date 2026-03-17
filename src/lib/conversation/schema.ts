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
  };
}
