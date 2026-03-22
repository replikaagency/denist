/**
 * Regex-based confirmation classification for the explicit appointment gate.
 * Kept deterministic — no LLM — and testable in isolation.
 */

export type ConfirmationClass = 'yes' | 'no' | 'ambiguous';

/** Accent-stripped lowercase for matching. */
export function normalizeConfirmationText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * True when the message asks to change date/time, negates the proposed slot,
 * or mixes affirmation with a correction — must NOT be treated as a clean "yes"
 * for booking confirmation.
 */
export function detectCorrectionSignals(text: string): boolean {
  const t = normalizeConfirmationText(text);
  if (!t) return false;

  // Clear one-shot affirmations — no correction layer.
  if (BARE_AFFIRMATION.test(t)) return false;

  // Pure decline (no "pero" / no slot objection).
  if (/^\s*no\s*$/.test(t)) return false;
  if (/^\s*no\s*[,!.]?\s*gracias\s*$/.test(t)) return false;

  if (MIXED_AFFIRM_THEN_BUT.test(t)) return true;
  if (AFFIRM_THEN_CHANGE_VERB.test(t)) return true;

  if (CONJUNCTION_OR_CONTRAST.test(t)) return true;
  if (CORRECTION_VERBS.test(t)) return true;
  if (TIME_OR_DATE_CHANGE.test(t)) return true;
  if (SLOT_NEGATION.test(t)) return true;

  return false;
}

/** "vale perfecto", "ok", "sí", etc. — whole message is agreement only. */
const BARE_AFFIRMATION =
  /^\s*(ok|vale|si|perfecto|genial|claro|dale|adelante|vamos|confirmo|yes|yep)(\s+(perfecto|genial|claro|gracias))?\s*[!?.]*\s*$/;

/** "sí pero …", "ok pero …", "vale pero …" */
const MIXED_AFFIRM_THEN_BUT =
  /\b(si|ok|vale|dale|perfecto|claro|genial)\s+(pero|aunque|mas bien|sin embargo)\b/;

/** "vale cambia", "ok cambiar …" */
const AFFIRM_THEN_CHANGE_VERB =
  /\b(vale|ok|dale)\s+(cambia|cambiar|modifica|modificar|ajusta|ajustar)\b/;

const CONJUNCTION_OR_CONTRAST =
  /\b(pero|aunque|en vez de|en lugar de|mejor dicho|sino que|sino)\b/;

const CORRECTION_VERBS =
  /\b(cambia|cambiar|modifica|modificar|corrige|corregir|actualiza|actualizar|ajusta|ajustar)\b/;

const TIME_OR_DATE_CHANGE =
  /\b(mañana|pasado manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b|\b(otra fecha|otro dia|otra hora|el horario|la hora|a las|fecha|horario preferido|mas tarde|mas temprano)\b|\b\d{1,2}\s*[:h]\s*\d{2}\b|\b\d{1,2}\/\d{1,2}\b/;

const SLOT_NEGATION =
  /\bno\s+(es|esa|e|esta)\s+(la\s+)?(fecha|hora|dia|servicio)\b|\bno\s+quiero\s+(esa|a esa|ese)\b|\bno\s+(a|para)\s+(esa|ese)\s+(hora|fecha|dia)\b/;

const UNCERTAINTY =
  /\b(no se|no lo se|no estoy seguro|no sabria|no tengo claro)\b/;

/**
 * Affirmative tokens (word-boundary). "vale" included — common spoken OK in ES.
 */
const YES =
  /\b(si|yes|confirmo|confirmar|correcto|exacto|adelante|perfecto|de acuerdo|ok|claro|por supuesto|genial|eso es|afirmo|afirmativo|dale|vamos|vale)\b/;

/**
 * Decline tokens. Intentionally omits standalone "cambiar" — that belongs in
 * detectCorrectionSignals / ambiguous, not a hard "no".
 */
const NO =
  /\b(no|cancelar|cancel|mejor no|prefiero no|espera|detener|nope|negativo|olvida|olvidalo|olvídalo)\b/;

/**
 * Classify the patient's reply. Mixed intent ("sí pero …", "ok pero …") and
 * any detectCorrectionSignals → ambiguous, never yes.
 *
 * Correction / slot-negation runs before yes|no so "no quiero esa hora" is
 * ambiguous (re-confirm), not a bare "no" decline.
 */
export function classifyConfirmation(text: string): ConfirmationClass {
  const t = normalizeConfirmationText(text);

  if (UNCERTAINTY.test(t)) return 'ambiguous';

  const hasYes = YES.test(t);
  const hasNo = NO.test(t);

  if (hasYes && hasNo) return 'ambiguous';

  if (detectCorrectionSignals(text)) return 'ambiguous';

  if (hasYes) return 'yes';
  if (hasNo) return 'no';

  return 'ambiguous';
}

/**
 * True when the patient clearly declines (same signals as confirmation "no"),
 * without also asking for a human (e.g. "no, quiero hablar con una persona").
 */
export function isPlainDecline(text: string): boolean {
  if (classifyConfirmation(text) !== 'no') return false;
  const t = normalizeConfirmationText(text);
  if (
    /\b(hablar con|ponme con|pone con|pasame con|pasa con|persona real|humano|operador|agente humano)\b/.test(
      t,
    )
  ) {
    return false;
  }
  return true;
}

/** Natural follow-up after the patient declines a service / appointment offer (Spanish). */
export const DECLINE_OFFER_FOLLOWUP_REPLY_ES =
  'Perfecto. Si quieres, también puedo ayudarte con horarios, precios, urgencias o resolver dudas. ¿Qué necesitas?';

// ---------------------------------------------------------------------------
// Frustration detection
// ---------------------------------------------------------------------------

/**
 * Patterns that unambiguously signal patient frustration with the bot.
 * Intentionally narrow — only clear signals. Borderline expressions ("ugh",
 * "esto es difícil") are left to the LLM (complaint / human_handoff_request).
 *
 * Note: "quiero hablar con una persona" is already caught by the LLM via
 * human_handoff_request intent — not duplicated here.
 */
const FRUSTRATION_PATTERNS: RegExp[] = [
  /no\s+me\s+entiendes?/,
  /no\s+me\s+ayudas?/,
  /no\s+sirves?\b/,
  /esto\s+no\s+(sirve|funciona)/,
  /eres?\s+un?\s+bot\b/,
  /hablo\s+con\s+una?\s+(maquina|robot|bot)/,
  /\binutil\b/,
  /me\s+(desespera|frustra)\b/,
  /estoy\s+(harto|harta|frustrado|frustrada)\b/,
  /que\s+asco\b/,
  /que\s+desastre\b/,
];

/**
 * Returns true when the message clearly signals the patient is frustrated
 * with the bot and should be routed to a human without waiting for the LLM
 * to classify it (which may take 3 low-confidence turns).
 */
export function isFrustrationSignal(text: string): boolean {
  const t = normalizeConfirmationText(text);
  return FRUSTRATION_PATTERNS.some((re) => re.test(t));
}

/** Reply shown when a frustration signal triggers deterministic escalation. */
export const FRUSTRATION_ESCALATION_REPLY_ES =
  'Lo siento, entiendo que esto ha sido frustrante. Voy a conectarte ahora con un miembro del equipo para que puedan atenderte directamente.';
