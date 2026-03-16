/**
 * Dental Reception AI — Intent & Urgency Taxonomy
 *
 * Every inbound patient message is classified along two orthogonal axes:
 *   1. Intent  — *what* the patient wants
 *   2. Urgency — *how quickly* a clinical response is needed
 *
 * These values drive downstream logic: which fields to collect, whether to
 * offer an appointment, and when to escalate to a human.
 */

import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// 1  INTENT TAXONOMY
// ---------------------------------------------------------------------------

export const IntentEnum = z.enum([
  // ── Scheduling ──────────────────────────────────────────────────────────
  "appointment_request",      // Wants to book a new appointment
  "appointment_reschedule",   // Wants to move an existing appointment
  "appointment_cancel",       // Wants to cancel an existing appointment
  "appointment_status",       // Asking about an upcoming appointment (date, time, prep)
  "availability_inquiry",     // Asking what slots are open, without committing

  // ── Clinical (non-diagnostic) ───────────────────────────────────────────
  "emergency_report",         // Reporting trauma, uncontrolled bleeding, severe swelling
  "symptom_report",           // Describing pain, sensitivity, or discomfort
  "post_treatment_concern",   // Reporting unexpected symptoms after a procedure

  // ── Information ─────────────────────────────────────────────────────────
  "service_inquiry",          // Asking what treatments/services the clinic provides
  "pricing_inquiry",          // Asking about costs (cleanings, crowns, implants…)
  "insurance_inquiry",        // Asking whether a plan is accepted or what's covered
  "provider_inquiry",         // Asking about a specific dentist's qualifications
  "clinic_info",              // Hours, address, parking, accessibility, languages

  // ── Administrative ──────────────────────────────────────────────────────
  "records_request",          // Requesting records transfer or copies
  "prescription_inquiry",     // Asking about an existing/needed prescription
  "billing_inquiry",          // Asking about a bill, balance, or payment plan
  "complaint",                // Expressing dissatisfaction with service or care
  "feedback",                 // Positive feedback or suggestion

  // ── Conversational ─────────────────────────────────────────────────────
  "greeting",                 // "Hi", "Hello", opening pleasantry
  "gratitude",                // "Thanks", "That's helpful"
  "confirmation",             // "Yes", "That works", affirming a prior message
  "denial",                   // "No", "That doesn't work", rejecting a prior offer
  "human_handoff_request",    // Explicitly asking to speak with a person

  // ── Boundary ────────────────────────────────────────────────────────────
  "out_of_scope",             // Not related to dental care or the clinic
  "unknown",                  // Ambiguous — not enough signal to classify
]);

export type Intent = z.infer<typeof IntentEnum>;

/**
 * Groups make it easier to write rules like "for any scheduling intent…"
 */
export const INTENT_GROUPS = {
  scheduling: [
    "appointment_request",
    "appointment_reschedule",
    "appointment_cancel",
    "appointment_status",
    "availability_inquiry",
  ],
  clinical: [
    "emergency_report",
    "symptom_report",
    "post_treatment_concern",
  ],
  information: [
    "service_inquiry",
    "pricing_inquiry",
    "insurance_inquiry",
    "provider_inquiry",
    "clinic_info",
  ],
  administrative: [
    "records_request",
    "prescription_inquiry",
    "billing_inquiry",
    "complaint",
    "feedback",
  ],
  conversational: [
    "greeting",
    "gratitude",
    "confirmation",
    "denial",
    "human_handoff_request",
  ],
  boundary: [
    "out_of_scope",
    "unknown",
  ],
} as const satisfies Record<string, readonly Intent[]>;

// ---------------------------------------------------------------------------
// 2  URGENCY TAXONOMY
// ---------------------------------------------------------------------------

export const UrgencyEnum = z.enum([
  "emergency",      // Immediate danger — trauma, uncontrolled bleeding, airway risk
  "urgent",         // Needs attention within 24 h — severe pain, broken tooth, lost crown
  "soon",           // Should be seen within ~1 week — moderate pain, growing sensitivity
  "routine",        // Standard scheduling — cleaning, checkup, cosmetic consult
  "informational",  // No clinical need right now — just questions
]);

export type Urgency = z.infer<typeof UrgencyEnum>;

/**
 * Clinical signals that help the LLM assign urgency.
 * Used inside the system prompt as reference material.
 */
export const URGENCY_SIGNALS: Record<Urgency, string[]> = {
  emergency: [
    "Knocked-out (avulsed) permanent tooth",
    "Uncontrolled oral bleeding",
    "Jaw fracture or suspected fracture",
    "Severe facial/oral swelling affecting breathing or swallowing",
    "Trauma with loss of consciousness",
  ],
  urgent: [
    "Severe, constant toothache unresponsive to OTC pain relief",
    "Broken or cracked tooth with sharp edges cutting soft tissue",
    "Lost crown or large filling exposing nerve",
    "Abscess or pus-filled swelling on the gum",
    "Post-extraction bleeding that won't stop after 30 min of pressure",
    "Fever combined with dental/facial pain",
  ],
  soon: [
    "Moderate tooth sensitivity to hot/cold",
    "Intermittent toothache that resolves",
    "Small chip with no pain",
    "Gum bleeding when brushing",
    "Loose permanent tooth without trauma",
  ],
  routine: [
    "Due for a cleaning or checkup",
    "Interested in whitening or cosmetic work",
    "Wants to start orthodontic evaluation",
    "New patient registration",
  ],
  informational: [
    "Asking about clinic hours or location",
    "Insurance or pricing question with no symptom",
    "General curiosity about a procedure",
  ],
};

// ---------------------------------------------------------------------------
// 3  CONFIDENCE THRESHOLDS
// ---------------------------------------------------------------------------

/**
 * The LLM reports a confidence score (0–1) for its intent classification.
 * These thresholds determine how the engine reacts.
 */
export const CONFIDENCE = {
  /** Act on the classified intent without clarification */
  HIGH: 0.85,
  /** Ask a short clarifying question before proceeding */
  MEDIUM: 0.6,
  /** Treat as "unknown" — ask an open-ended clarifying question */
  LOW: 0.6,
} as const;
