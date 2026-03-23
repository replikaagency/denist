/**
 * Dental Reception AI — Required Fields by Conversation Stage
 *
 * Each intent maps to a set of fields that must be collected before the
 * conversation can advance to its "completion action" (e.g. offering
 * appointment slots, escalating to a human, or providing information).
 *
 * Fields are split into:
 *   - required  — conversation cannot proceed without these
 *   - optional  — nice to have; ask only if the flow feels natural
 *
 * The conversation engine asks for ONE missing required field per turn
 * (never dumps a form on the patient).
 */

import type { Intent } from "./taxonomy";

// ---------------------------------------------------------------------------
// Field path type — dot-notation paths into ConversationState
// ---------------------------------------------------------------------------

export type FieldPath =
  | `patient.${string}`
  | `appointment.${string}`
  | `symptoms.${string}`;

export interface FieldRequirements {
  required: FieldPath[];
  optional: FieldPath[];
  /** Prompt hint: the natural-language question to ask for each field */
  prompts: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Shared prompt hints (reused across intents)
// ---------------------------------------------------------------------------

const COMMON_PROMPTS: Record<string, string> = {
  "patient.full_name":
    "¿Me dices tu nombre completo?",
  "patient.phone":
    "¿A qué número te podemos llamar?",
  "patient.email":
    "Si quieres, también puedo añadir un correo para enviarte el resumen.",
  "patient.date_of_birth":
    "¿Y tu fecha de nacimiento? La necesitamos para localizar tu ficha.",
  "patient.new_or_returning":
    "¿Es la primera vez que vienes a la clínica o ya eres paciente nuestro/a?",
  "patient.insurance_provider":
    "¿Con qué compañía de seguros estás?",
  "patient.insurance_member_id":
    "¿Puedes decirme tu número de afiliado? Lo encontrarás en tu tarjeta de seguro.",
  "appointment.service_type":
    "¿Para qué tipo de tratamiento quieres la cita? ¿Una limpieza, revisión, o algo distinto?",
  "appointment.preferred_date":
    "¿Qué día te vendría mejor?",
  "appointment.preferred_time":
    "¿En qué franja horaria prefieres? ¿Mañana, tarde, o tienes un horario concreto?",
  "appointment.preferred_provider":
    "¿Quieres que sea con algún dentista en concreto?",
  "symptoms.description":
    "¿Puedes contarme qué te está pasando?",
  "symptoms.location":
    "¿En qué zona de la boca tienes la molestia?",
  "symptoms.duration":
    "¿Desde cuándo lo tienes?",
  "symptoms.pain_level":
    "Del 0 al 10, ¿cómo puntuarías el dolor?",
  "symptoms.triggers":
    "¿Hay algo que lo empeore, como el frío, el calor o morder?",
};

// ---------------------------------------------------------------------------
// Per-intent field requirements
// ---------------------------------------------------------------------------

export const FIELD_REQUIREMENTS: Partial<Record<Intent, FieldRequirements>> = {

  // ── Scheduling ──────────────────────────────────────────────────────────

  appointment_request: {
    required: [
      "patient.full_name",
      "patient.phone",
      "patient.new_or_returning",
      "appointment.service_type",
      "appointment.preferred_date",
      "appointment.preferred_time",
    ],
    optional: [
      "patient.email",
      "patient.date_of_birth",
      "appointment.preferred_provider",
      "patient.insurance_provider",
    ],
    prompts: COMMON_PROMPTS,
  },

  appointment_reschedule: {
    required: [
      "patient.full_name",
      "patient.phone",
      "appointment.preferred_date",
      "appointment.preferred_time",
    ],
    optional: [
      "appointment.preferred_provider",
    ],
    prompts: COMMON_PROMPTS,
  },

  appointment_cancel: {
    required: [
      "patient.full_name",
      "patient.phone",
    ],
    optional: [],
    prompts: COMMON_PROMPTS,
  },

  availability_inquiry: {
    required: [
      "appointment.service_type",
    ],
    optional: [
      "appointment.preferred_date",
      "appointment.preferred_time",
      "appointment.preferred_provider",
    ],
    prompts: COMMON_PROMPTS,
  },

  // ── Clinical ────────────────────────────────────────────────────────────

  emergency_report: {
    required: [
      "patient.full_name",
      "patient.phone",
      "symptoms.description",
    ],
    optional: [
      "symptoms.location",
      "symptoms.duration",
      "symptoms.pain_level",
    ],
    prompts: COMMON_PROMPTS,
  },

  symptom_report: {
    required: [
      "symptoms.description",
      "symptoms.duration",
      "symptoms.pain_level",
    ],
    optional: [
      "symptoms.location",
      "symptoms.triggers",
      "patient.full_name",
      "patient.phone",
    ],
    prompts: COMMON_PROMPTS,
  },

  post_treatment_concern: {
    required: [
      "patient.full_name",
      "symptoms.description",
      "symptoms.prior_treatment",
    ],
    optional: [
      "symptoms.duration",
      "symptoms.pain_level",
      "patient.phone",
    ],
    prompts: {
      ...COMMON_PROMPTS,
      "symptoms.prior_treatment":
        "¿Qué tratamiento te hicieron y hace cuánto tiempo aproximadamente?",
    },
  },

  // ── Insurance ───────────────────────────────────────────────────────────

  insurance_inquiry: {
    required: [
      "patient.insurance_provider",
    ],
    optional: [
      "patient.insurance_member_id",
      "appointment.service_type",
    ],
    prompts: COMMON_PROMPTS,
  },

  // ── Administrative ──────────────────────────────────────────────────────

  billing_inquiry: {
    required: [
      "patient.full_name",
      "patient.phone",
    ],
    optional: [
      "patient.date_of_birth",
    ],
    prompts: COMMON_PROMPTS,
  },

  records_request: {
    required: [
      "patient.full_name",
      "patient.date_of_birth",
      "patient.phone",
    ],
    optional: [
      "patient.email",
    ],
    prompts: COMMON_PROMPTS,
  },

  complaint: {
    required: [],
    optional: [
      "patient.full_name",
      "patient.phone",
    ],
    prompts: COMMON_PROMPTS,
  },
};

// ---------------------------------------------------------------------------
// Helper: compute missing required fields for an intent
// ---------------------------------------------------------------------------

export function getMissingFields(
  intent: Intent,
  filledFields: Record<string, unknown>,
): FieldPath[] {
  const reqs = FIELD_REQUIREMENTS[intent];
  if (!reqs) return [];

  return reqs.required.filter((path) => {
    const value = getNestedValue(filledFields, path);
    return value === null || value === undefined || value === "";
  });
}

/**
 * Get the next field prompt to present. Returns null if all required
 * fields are filled.
 */
export function getNextFieldPrompt(
  intent: Intent,
  filledFields: Record<string, unknown>,
): { field: FieldPath; prompt: string } | null {
  const reqs = FIELD_REQUIREMENTS[intent];
  if (!reqs) return null;

  const missing = getMissingFields(intent, filledFields);
  if (missing.length === 0) return null;

  const field = missing[0];
  return {
    field,
    prompt: reqs.prompts[field] ?? `¿Me puedes indicar tu ${field.split(".").pop()}?`,
  };
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
