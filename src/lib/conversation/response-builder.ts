/**
 * Canonical UX copy and small string builders for chat turns (no I/O).
 */

import type { ConversationState } from '@/lib/conversation/schema';

export const ENTRY_REPLY_BOOKING = 'Claro, te ayudo 👍\n¿Ya has venido antes o es tu primera vez?';
export const ENTRY_REPLY_URGENCY = 'Siento que estés así.\nCuéntame qué te pasa y lo gestiono cuanto antes.';
export const ENTRY_REPLY_TREATMENT_INFO = 'Claro 👍 ¿Es sobre precios, tratamientos o seguros?';
export const ENTRY_REPLY_RESCHEDULE = 'De acuerdo, lo gestiono.\n¿Para cuándo tenías la cita?';

// --- Booking Entry Gate Constants ---
export const ENTRY_BOOKING_PATIENT_STATUS_OPTIONS = [
  { label: 'Ya soy paciente', value: 'patient_status_returning' },
  { label: 'Es mi primera vez', value: 'patient_status_new' },
];

export const ENTRY_BOOKING_GATE_REPROMPT =
  '¿Ya has venido antes o es tu primera vez?';

export const ENTRY_BOOKING_RETURNING_ASK_PHONE =
  'Perfecto. ¿Me das tu número de teléfono?';

export const ENTRY_BOOKING_RETURNING_FOUND =
  'Perfecto, ya te tengo 👍\n¿Te viene mejor esta semana o la próxima?';

export const ENTRY_BOOKING_RETURNING_NOT_FOUND =
  'No te encuentro con ese número.\nDime tu nombre completo y seguimos.';

export const ENTRY_BOOKING_RETURNING_AMBIGUOUS =
  'Hay más de un registro con ese número.\nDime tu nombre completo para localizarte.';

export const ENTRY_BOOKING_NEW_ASK_DETAILS =
  'Perfecto. ¿Me dices tu nombre y teléfono?';

export const CORRECTION_CHOICE_OPTIONS = [
  { label: 'Cambiar fecha', value: 'change_date' },
  { label: 'Cambiar hora', value: 'change_time' },
  { label: 'Cambiar servicio', value: 'change_service' },
];

export const EMAIL_FOLLOWUP_OPTIONS = [
  { label: '1. Añadir correo', value: 'email_add_yes' },
  { label: '2. No, gracias', value: 'email_add_no' },
];

export const QUICK_BOOKING_PATH_OPTIONS = [
  { label: 'Elegir hora directamente', value: 'quick_path_direct' },
  { label: 'Dejar preferencia a recepción', value: 'quick_path_reception' },
];

export const BOOKING_PATH_STRICT_PROMPT =
  '¿Cómo prefieres seguir?\n1️⃣ Reservar online · 2️⃣ Dejar solicitud para que te contacten\nEscribe 1 o 2 👇';

export const OPTIONAL_EMAIL_STRICT_PROMPT =
  '¿Quieres añadir un correo para enviarte el resumen?\n1️⃣ Sí, añadir correo · 2️⃣ No, gracias\nEscribe 1 o 2 👇';

export const RECEPTION_PHONE_GATE_INVALID_REPLY =
  'Necesito un móvil español válido.\nEjemplo: 612 345 678';

export const ASAP_SLOT_INVALID_REPLY =
  'Elige una de las opciones que te pasé.\nResponde solo con 1, 2 o 3 👇';

export const GREETING_CANONICAL_REPLY =
  'Hola 👋 Soy el asistente de la clínica.\n¿Es para pedir cita, tienes alguna molestia o quieres información?';

export const SIMPLE_INFO_INTENT_REPLY =
  'Puedo ayudarte con horarios, precios, seguros o citas.\n¿Qué necesitas?';

export const CONFIRMATION_CHANGE_ROUTING_REPLY =
  'Sin problema. ¿Qué cambias: fecha, hora o servicio?\nSi es urgente, escríbemelo.';

export const CONFIRMATION_CLARIFY_HARD_GATE_REPLY =
  '¿Lo confirmas o quieres cambiar algo?\nSi es urgente, escríbemelo.';

export function buildReceptionCapturePrompt(field: string, prompt: string): string {
  if (field === 'appointment.preferred_date' || field === 'appointment.preferred_time') {
    return `Perfecto, lo gestiono con recepción.\nDime día y franja horaria que te vengan bien.\n${prompt}`;
  }
  return prompt;
}

export function isSimpleThanksOnly(message: string): boolean {
  const t = message.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  return /^(gracias|muchas gracias)$/.test(t);
}

export function isSimpleGoodbyeOnly(message: string): boolean {
  const t = message.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  return /^(adios|gracias adios|hasta luego)$/.test(t);
}

export function isSimpleAckOnly(message: string): boolean {
  const t = message.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  return /^(ok|vale)$/.test(t);
}

export function isSimpleGreetingOnly(message: string): boolean {
  const t = message.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  // bare greeting
  if (/^(hola|holi|hey|buenas|buenos dias|buenas tardes)[!. ]*$/.test(t)) return true;
  // assistant-entry framing: "quiero hablar con el asistente [de la clínica X]"
  if (/\bquiero\s+hablar\s+con\s+(el\s+)?asistente\b/.test(t)) return true;
  return false;
}

/**
 * Bare phrases like "duda", "info", "pregunta" or common info keywords (horarios, precios, …).
 */
export function isSimpleInfoIntent(message: string): boolean {
  const t = message.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  if (!t) return false;
  if (/^(info|informacion|duda|dudas|pregunta|preguntas)[.!?]*$/.test(t)) return true;
  if (/^resolver\s+dudas[.!?]*$/.test(t)) return true;
  if (/\btengo\s+una\s+duda\b/.test(t)) return true;
  return /\b(horario|horarios|precio|precios|seguro|seguros|cobertura|direccion|como llegar|donde|ubicacion|telefono|contacto|informacion)\b/.test(
    t,
  );
}

function formatPreferredDateForPatientSummary(raw: string): string {
  if (raw.trim().toLowerCase() === 'earliest_available') return 'Primera disponibilidad';
  return raw;
}

function formatPreferredTimeForPatientSummary(raw: string): string {
  if (raw.trim().toLowerCase() === 'flexible') return 'Cualquier hora (flexible)';
  return raw;
}

export function buildConfirmationSummary(
  patient: ConversationState['patient'],
  appointment: ConversationState['appointment'],
): string {
  const details: string[] = [];
  if (patient.full_name) details.push(`Nombre: ${patient.full_name}`);
  if (patient.phone) details.push(`Tel: ${patient.phone}`);
  if (appointment.service_type) details.push(`Servicio: ${appointment.service_type}`);
  if (appointment.preferred_date) {
    details.push(`Fecha: ${formatPreferredDateForPatientSummary(appointment.preferred_date)}`);
  }
  if (appointment.preferred_time) {
    details.push(`Hora: ${formatPreferredTimeForPatientSummary(appointment.preferred_time)}`);
  }
  if (appointment.preferred_provider) details.push(`Dentista: ${appointment.preferred_provider}`);
  const lines: string[] = [
    'Te apunto esto 👇',
    ...details,
    '¿Está todo bien?',
  ];
  return lines.join('\n');
}

export function buildRescheduleConfirmationSummary(
  oldSummary: string,
  patient: ConversationState['patient'],
  newAppointment: ConversationState['appointment'],
): string {
  const newDetails: string[] = [];
  if (patient.full_name) newDetails.push(`Nombre: ${patient.full_name}`);
  if (newAppointment.service_type) newDetails.push(`Servicio: ${newAppointment.service_type}`);
  if (newAppointment.preferred_date) {
    newDetails.push(`Fecha: ${formatPreferredDateForPatientSummary(newAppointment.preferred_date)}`);
  }
  if (newAppointment.preferred_time) {
    newDetails.push(`Hora: ${formatPreferredTimeForPatientSummary(newAppointment.preferred_time)}`);
  }
  if (newAppointment.preferred_provider) newDetails.push(`Dentista: ${newAppointment.preferred_provider}`);
  const lines: string[] = [
    `Cita actual: ${oldSummary}`,
    'Nueva preferencia:',
    ...newDetails,
    '¿Lo cambio así?',
  ];
  return lines.join('\n');
}

type BookingSideQuestionFollowupParams = {
  patientMessage: string;
  state: ConversationState;
  currentReply: string;
  nextAction: string;
  shouldEscalate: boolean;
  getNextPrompt: (
    state: ConversationState,
    intent: string | null | undefined,
  ) => { field: string; prompt: string } | null;
};

export function buildBookingSideQuestionFollowup(
  params: BookingSideQuestionFollowupParams,
): string | null {
  const { patientMessage, state, currentReply, nextAction, shouldEscalate, getNextPrompt } = params;
  if (shouldEscalate || state.awaiting_confirmation) return null;
  if (state.current_intent !== 'appointment_request' && state.current_intent !== 'appointment_reschedule')
    return null;
  if (nextAction === 'ask_field') return null;
  if (!isBookingSideQuestion(patientMessage)) return null;

  const nextPrompt = getNextPrompt(state, state.current_intent);
  if (!nextPrompt?.prompt) return null;
  if (currentReply.toLowerCase().includes(nextPrompt.prompt.toLowerCase())) return null;

  return `Dicho esto, seguimos:\n${nextPrompt.prompt}`;
}

function isBookingSideQuestion(message: string): boolean {
  const t = message.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const SIDE_QUESTION_PATTERNS: RegExp[] = [
    /\b(precio|precios|cuanto cuesta|coste|tarifa)\b/,
    /\b(duele|dolor|molesta|anestesia)\b/,
    /\b(hueco|disponibilidad|teneis hoy|teneis para hoy|hay para hoy|hoy)\b/,
    /\b(mutua|seguro|aseguradora|cobertura|cubre)\b/,
    /\b(cuanto tarda|duracion|como funciona|en que consiste|diferencia)\b/,
  ];
  return SIDE_QUESTION_PATTERNS.some((re) => re.test(t));
}
