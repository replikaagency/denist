/**
 * Deterministic recovery when the patient leads with "no" but is correcting
 * scheduling preferences ("no pero mejor el martes"). The LLM may emit invalid JSON;
 * this builds a valid LLMTurnOutput-shaped payload for processTurn.
 */

import type { ConversationState, CorrectionField, LLMTurnOutput } from '@/lib/conversation/schema';
import { detectCorrectionSignals, normalizeConfirmationText } from '@/lib/conversation/confirmation';

const WEEKDAY =
  /\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/gi;

function capitalizeWord(s: string): string {
  const t = s.trim();
  if (!t) return t;
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

/**
 * True when the message starts with "no" (possibly "no,") and carries
 * scheduling correction signals — not a bare decline.
 *
 * Note: normalizeConfirmationText strips accents, so "mañana" → "manana".
 * detectCorrectionSignals can miss "por la mañana" because TIME_OR_DATE_CHANGE
 * matches the accented form; we add explicit fallbacks for negation-led fixes.
 */
export function isNegationLedSchedulingCorrection(text: string): boolean {
  const t = normalizeConfirmationText(text);
  if (!/^\s*no\b/.test(t) && !/^\s*no\s*,/.test(t)) return false;
  if (detectCorrectionSignals(text)) return true;
  if (/\bno\s*,\s*mejor\b/.test(t)) return true;
  if (/\bno\s+pero\b/.test(t)) return true;
  return false;
}

/**
 * Extract weekday / time preference from negation-led correction phrases.
 */
export function extractSchedulingPreferenceFromNegationCorrection(text: string): {
  preferred_date?: string;
  preferred_time?: string;
} | null {
  const t = normalizeConfirmationText(text);
  const out: { preferred_date?: string; preferred_time?: string } = {};

  if (/\bpor\s+la\s+manana\b/.test(t) || /\bpor\s+las\s+mananas\b/.test(t)) {
    out.preferred_time = 'morning';
  } else if (/\bpor\s+la\s+tarde\b/.test(t) || /\bpor\s+las\s+tardes\b/.test(t)) {
    out.preferred_time = 'afternoon';
  } else if (/\bpor\s+la\s+noche\b/.test(t) || /\bpor\s+las\s+noches\b/.test(t)) {
    out.preferred_time = 'evening';
  } else if (/\ba\s+partir\s+de\s+las\s+(\d{1,2}(?:[:.]\d{2})?)\b/.test(t)) {
    const m = t.match(/\ba\s+partir\s+de\s+las\s+(\d{1,2}(?:[:.]\d{2})?)\b/);
    if (m) out.preferred_time = `a partir de las ${m[1].replace('.', ':')}`;
  }

  const dayTokens = [...t.matchAll(WEEKDAY)].map((m) => m[1].toLowerCase());
  if (/en\s+vez\s+de|en\s+lugar\s+de/.test(t) && dayTokens.length >= 2) {
    out.preferred_date = capitalizeWord(dayTokens[dayTokens.length - 1]);
  } else {
    const mejorEl = t.match(/\bmejor\s+(?:el|la)\s+(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/);
    const cambiarA = t.match(/\bcambiar\s+a\s+(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/);
    const elDia = t.match(/\bel\s+(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/);
    if (cambiarA) {
      out.preferred_date = capitalizeWord(cambiarA[1]);
    } else if (mejorEl) {
      out.preferred_date = capitalizeWord(mejorEl[1]);
    } else if (elDia && /pero|mejor|cambiar|vez/.test(t)) {
      out.preferred_date = capitalizeWord(elDia[1]);
    } else if (dayTokens.length === 1 && /pero|mejor|cambiar|vez/.test(t)) {
      out.preferred_date = capitalizeWord(dayTokens[0]);
    }
  }

  if (!out.preferred_date && !out.preferred_time) return null;
  return out;
}

function buildSyntheticReply(
  extracted: { preferred_date?: string; preferred_time?: string },
  prev: ConversationState['appointment'],
): string {
  const timeLabel = (v: string | null | undefined): string => {
    if (!v) return '';
    const s = String(v).toLowerCase();
    if (s === 'morning') return 'por la mañana';
    if (s === 'afternoon') return 'por la tarde';
    if (s === 'evening') return 'por la noche';
    return String(v);
  };

  if (extracted.preferred_date && !extracted.preferred_time) {
    const follow =
      prev.preferred_time != null && String(prev.preferred_time).trim() !== ''
        ? ` ¿Sigues prefiriendo ${timeLabel(prev.preferred_time)}?`
        : ' ¿Quieres indicarme también la franja horaria que prefieres?';
    return `Perfecto, actualizo la preferencia a ${extracted.preferred_date}.${follow}`;
  }

  if (extracted.preferred_time && !extracted.preferred_date) {
    const tl = timeLabel(extracted.preferred_time);
    const follow =
      prev.preferred_date != null && String(prev.preferred_date).trim() !== ''
        ? ` ¿Te sigue bien el día que comentamos (${prev.preferred_date})?`
        : ' ¿Qué día te vendría mejor?';
    return `Perfecto, actualizo la preferencia de horario a ${tl}.${follow}`;
  }

  const d = extracted.preferred_date ?? '';
  const tl = extracted.preferred_time ? timeLabel(extracted.preferred_time) : '';
  return `Perfecto, he anotado el cambio: ${d}${d && tl ? ' · ' : ''}${tl}. ¿Quieres ajustar algo más?`;
}

/**
 * Returns a JSON string valid for LLMTurnOutputSchema, or null if this path does not apply.
 */
export function tryBuildSyntheticNegationSchedulingCorrectionJson(
  patientMessage: string,
  state: ConversationState,
): string | null {
  const intent = state.current_intent;
  if (intent !== 'appointment_request' && intent !== 'appointment_reschedule') {
    return null;
  }
  if (!isNegationLedSchedulingCorrection(patientMessage)) return null;

  const extracted = extractSchedulingPreferenceFromNegationCorrection(patientMessage);
  if (!extracted) return null;

  const correction_fields: CorrectionField[] = [];
  const appointment: NonNullable<LLMTurnOutput['appointment']> = {};
  if (extracted.preferred_date) {
    appointment.preferred_date = extracted.preferred_date;
    correction_fields.push('preferred_date');
  }
  if (extracted.preferred_time) {
    appointment.preferred_time = extracted.preferred_time;
    correction_fields.push('preferred_time');
  }
  if (correction_fields.length === 0) return null;

  const reply = buildSyntheticReply(extracted, state.appointment);

  const out: LLMTurnOutput = {
    intent,
    intent_confidence: 0.92,
    secondary_intent: null,
    urgency: 'routine',
    urgency_reasoning: 'El paciente corrige una preferencia de fecha u horario.',
    patient_fields: {},
    appointment,
    symptoms: {},
    next_action: 'ask_field',
    missing_fields: [],
    escalation_reason: null,
    reply,
    contains_diagnosis: false,
    contains_pricing: false,
    is_correction: true,
    correction_fields,
    hybrid_booking: null,
  };

  return JSON.stringify(out);
}
