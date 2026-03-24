// ---------------------------------------------------------------------------
// Boolean guards (yes/no)
// ---------------------------------------------------------------------------

/**
 * Returns true if the message is a clear "yes" (Spanish or English, robust to accents).
 */
export function isYes(message: string): boolean {
  const norm = removeDiacritics(message.trim().toLowerCase());
  return /^(si|sí|s|yes|y|claro|de acuerdo|por supuesto|correcto|afirmativo|eso es|exacto|cierto|seguro|ajá|aha|así es|así|asi|perfecto|efectivamente)[.!?\s]*$/i.test(norm);
}

/**
 * Returns true if the message is a clear "no" (Spanish or English, robust to accents).
 */
export function isNo(message: string): boolean {
  const norm = removeDiacritics(message.trim().toLowerCase());
  return /^(no|n|negativo|para nada|en absoluto|nope|nah|nunca|jamás|jamas)[.!?\s]*$/i.test(norm);
}

// ---------------------------------------------------------------------------
// Exported looksLike* wrappers for intake fields
// ---------------------------------------------------------------------------

export function looksLikeFullName(message: string): boolean {
  return !!extractNameGuard(message);
}

export function looksLikePhone(message: string): boolean {
  return !!extractPhoneGuard(message);
}

export function looksLikeEmail(message: string): boolean {
  return !!extractEmailGuard(message);
}

export type TimePreferenceGuardResult =
  | { kind: 'value'; value: string }
  | { kind: 'ask_exact' };

export type FastBookingDetails = {
  full_name?: string;
  phone?: string;
  service_type?: string;
  preferred_date?: string;
  preferred_time?: string;
  new_or_returning?: 'new' | 'returning';
};

/** Canonical `appointment.preferred_date` when the patient wants the first available slot. */
export const EARLIEST_AVAILABLE_PREFERRED_DATE = 'earliest_available';

export type OpenAvailabilityPreferenceKind = 'earliest_slot' | 'flexible_time_only';

/**
 * Detect open / ASAP availability intent (deterministic; do not rely on the LLM).
 * - earliest_slot → map to canonical date + flexible time
 * - flexible_time_only → any hour / indifferent to time (when asking for time)
 */
export function extractOpenAvailabilityPreference(message: string): OpenAvailabilityPreferenceKind | null {
  const trimmed = message.trim();
  if (!trimmed) return null;
  const norm = removeDiacritics(trimmed.toLowerCase());

  if (
    /\bme\s+da\s+igual\s+(la\s+)?hora\b/.test(norm) ||
    /\bme\s+es\s+igual\s+(la\s+)?hora\b/.test(norm) ||
    /\bcualquier\s+hora\b/.test(norm) ||
    /\bda\s+igual\s+(la\s+)?hora\b/.test(norm)
  ) {
    return 'flexible_time_only';
  }

  if (
    /\bprimera\s+disponib/.test(norm) ||
    /\blo\s+antes\s+posible\b/.test(norm) ||
    /\bcuanto\s+antes\b/.test(norm) ||
    /\bcuando\s+haya\s+hueco\b/.test(norm) ||
    /\bcualquier\s+dia\b/.test(norm) ||
    /\bcualquier\s+momento\b/.test(norm) ||
    /\bcuando\s+pueda\b/.test(norm) ||
    /\bcuando\s+puedan\b/.test(norm) ||
    /\blo\s+primero\s+que\s+(pueda|haya)\b/.test(norm) ||
    /\bprimer\s+hueco\b/.test(norm) ||
    /\bprimer\s+agujero\b/.test(norm) ||
    /\b(en\s+cuanto\s+)?antes\s+posible\b/.test(norm)
  ) {
    return 'earliest_slot';
  }

  return null;
}
/**
 * Dental Reception AI — Deterministic Intake Guards
 *
 * Regex/pattern-based extractors for structured patient fields.
 * Applied BEFORE falling back to "no te he entendido" when the LLM fails to
 * extract a field from a simple, structured input.
 *
 * Design principles:
 *   - Conservative: false positives are worse than misses.
 *   - Gated on the FIRST missing field: we only try the guard that matches
 *     what the bot is currently asking for, to avoid mis-capturing.
 *   - No I/O: pure functions, safe to unit-test without mocks.
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function removeDiacritics(str: string): string {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function capitalizeWords(str: string): string {
  return str
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/** Words that are NOT human names even if they look like one. */
const SPANISH_NAME_STOP_WORDS = new Set([
  'si', 'sí', 'no', 'ok', 'vale', 'claro', 'hola', 'gracias', 'adios', 'adiós',
  'bueno', 'bien', 'nada', 'ya', 'ah', 'eh',
  // Time
  'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo',
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'octubre', 'noviembre', 'diciembre',
  'hoy', 'manana', 'tarde', 'noche', 'pronto', 'ahora',
  // Common patient words
  'primera', 'vez', 'nuevo', 'nueva', 'paciente', 'cita', 'urgente', 'urgencia',
  'quiero', 'necesito', 'tengo', 'dolor', 'limpieza', 'revision', 'ortodoncia',
]);

// ---------------------------------------------------------------------------
// Full name guard
// ---------------------------------------------------------------------------

/**
 * Detect a human name from the patient's message.
 * Returns a properly-capitalised name string, or null if not confident.
 *
 * Handles:
 *   - Prefixed:  "me llamo María García", "soy Carlos López"
 *   - Bare:      "María García" (2–4 words, all alpha, no stop words)
 */
export function extractNameGuard(message: string): string | null {
  const normalized = message.trim();
  if (!normalized || normalized.length > 80) return null;

  const ALPHA = /^[a-záéíóúüñA-ZÁÉÍÓÚÜÑ]+$/;

  function isValidName(raw: string): string | null {
    const words = raw.trim().split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 4) return null;
    if (!words.every((w) => ALPHA.test(w) && w.length >= 2)) return null;
    if (words.some((w) => SPANISH_NAME_STOP_WORDS.has(removeDiacritics(w.toLowerCase())))) return null;
    return capitalizeWords(raw.trim());
  }

  // Pattern 1: explicit prefix ("me llamo X", "soy X", "mi nombre es X")
  const prefixMatch = normalized.match(
    /(?:me\s+llamo|mi\s+nombre\s+es|llámame|llamame|me\s+llaman|soy)\s+([A-ZÁÉÍÓÚÜÑA-Za-záéíóúüñ].+)/i,
  );
  if (prefixMatch?.[1]) {
    const candidate = prefixMatch[1].replace(/[^a-záéíóúüñA-ZÁÉÍÓÚÜÑ\s]/g, '').trim();
    const result = isValidName(candidate);
    if (result) return result;
  }

  // Pattern 2: bare message — must be ONLY alpha words (no extra text)
  if (/^[a-záéíóúüñA-ZÁÉÍÓÚÜÑ\s]+$/.test(normalized)) {
    return isValidName(normalized);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Phone guard (Spanish)
// ---------------------------------------------------------------------------

/**
 * Extract a Spanish phone number from the patient's message.
 * Handles: mobile (6xx/7xx), landline (8xx/9xx), +34 and 0034 prefixes,
 * spaces/dashes as separators, and numbers embedded in a sentence.
 *
 * Returns a clean string of digits (or "+34XXXXXXXXX" when prefix detected).
 */
export function extractPhoneGuard(message: string): string | null {
  if (!message || message.length > 200) return null;

  /** Strip separators and validate as a 9-digit Spanish number → "+34XXXXXXXXX" */
  function normalize(raw: string): string | null {
    const digits = raw.replace(/[\s\-\.]/g, '');
    if (/^\+?34([6789]\d{8})$/.test(digits)) return `+34${digits.replace(/^\+?34/, '')}`;
    if (/^0034([6789]\d{8})$/.test(digits))  return `+34${digits.slice(4)}`;
    if (/^([6789]\d{8})$/.test(digits))      return `+34${digits}`;
    return null;
  }

  // Whole message is a phone (bare, +34, 0034, with spaces/dashes)
  const whole = normalize(message.trim());
  if (whole) return whole;

  // Embedded in sentence: "mi número es 612 34 56 78", "llámame al +34 666 777 888"
  const m = message.match(
    /(?:es|al|número|numero|teléfono|telefono|tel\.?|telf\.?|móvil|movil|cel\.?|:)\s*(\+?(?:34\s?)?[6789][\s\d\-]{8,14})/i,
  );
  if (m) return normalize(m[1]);

  return null;
}

// ---------------------------------------------------------------------------
// Email guard
// ---------------------------------------------------------------------------

/**
 * Extract an email address from the patient's message.
 * Returns the address lowercased, or null if none found.
 */
export function extractEmailGuard(message: string): string | null {
  if (!message) return null;
  const match = message.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  return match ? match[0].toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// New-or-returning guard
// ---------------------------------------------------------------------------

/**
 * Classify the patient as "new" or "returning" from their message.
 * Returns null when the message is ambiguous (e.g. a bare "sí").
 */
export function extractNewOrReturningGuard(message: string): 'new' | 'returning' | null {
  const norm = removeDiacritics(message.toLowerCase().trim());

  // Structured UI shortcuts from chat buttons.
  if (norm === 'patient_status_new') return 'new';
  if (norm === 'patient_status_returning') return 'returning';

  const RETURNING_SIGNALS = [
    'ya soy paciente', 'soy paciente', 'ya vengo', 'ya he venido', 'ya he ido',
    'vuelvo', 'de siempre', 'tengo ficha', 'tengo historial', 'ya estoy',
    'paciente vuestro', 'paciente suyo', 'ya os conozco', 'ya los conozco',
    'hace tiempo que vengo', 'llevo tiempo', 'sigo siendo', 'he ido antes',
    'ya fui', 'ya he ido antes',
  ];

  const NEW_SIGNALS = [
    'primera vez', 'es la primera', 'nunca he venido', 'nunca he ido',
    'no he venido', 'no he ido antes', 'soy nuevo', 'soy nueva',
    'nunca antes', 'primera visita', 'nunca he estado', 'es mi primera vez',
    'es la primera vez',
  ];

  for (const signal of RETURNING_SIGNALS) {
    if (norm.includes(removeDiacritics(signal))) return 'returning';
  }
  for (const signal of NEW_SIGNALS) {
    if (norm.includes(removeDiacritics(signal))) return 'new';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Time preference guard
// ---------------------------------------------------------------------------

/**
 * Extract deterministic time preference values from button tokens or free text.
 * - time_morning -> morning
 * - time_afternoon -> afternoon
 * - time_exact -> ask for exact hour on next question
 * Also detects manual input like "mañana", "tarde", "a las 10:30", "sobre las 17".
 */
export function extractTimePreferenceGuard(message: string): TimePreferenceGuardResult | null {
  const trimmed = message.trim();
  if (!trimmed) return null;
  const norm = removeDiacritics(trimmed.toLowerCase());

  if (norm === 'time_morning') return { kind: 'value', value: 'morning' };
  if (norm === 'time_afternoon') return { kind: 'value', value: 'afternoon' };
  if (norm === 'time_exact') return { kind: 'ask_exact' };

  if (norm === 'flexible' || /\bhorario\s+flexible\b/.test(norm)) {
    return { kind: 'value', value: 'flexible' };
  }

  // Real-world shorthand like "mañana tarde" usually means date+time ("tomorrow afternoon").
  if (/\bmanana\b/.test(norm) && /\btarde\b/.test(norm) && !/\bpor\s+la\s+manana\b/.test(norm)) {
    return { kind: 'value', value: 'afternoon' };
  }

  if (
    /\b(por\s+la\s+manana|por\s+las\s+mananas|de\s+la\s+manana|manana|temprano)\b/.test(norm)
  ) {
    return { kind: 'value', value: 'morning' };
  }
  if (/\b(por\s+la\s+tarde|por\s+las\s+tardes|de\s+la\s+tarde|tarde)\b/.test(norm)) {
    return { kind: 'value', value: 'afternoon' };
  }

  const exactMatch = trimmed.match(/\b(?:a|sobre)\s+las\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (exactMatch) {
    const hour = exactMatch[1];
    const mins = exactMatch[2] ? `:${exactMatch[2]}` : '';
    const ampm = exactMatch[3] ? ` ${exactMatch[3].toLowerCase()}` : '';
    return { kind: 'value', value: `a las ${hour}${mins}${ampm}`.trim() };
  }

  return null;
}

/**
 * Extract multiple booking details from a single patient message.
 * Conservative by design: only obvious service/date/time/status signals.
 */
export function extractFastBookingDetails(message: string): FastBookingDetails {
  const details: FastBookingDetails = {};
  const trimmed = message.trim();
  if (!trimmed) return details;

  const norm = removeDiacritics(trimmed.toLowerCase());

  const embeddedNameMatch = trimmed.match(
    /(?:^|[\s,;])(?:soy|me llamo|mi nombre es)\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{2,}(?:\s+[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{2,}){1,3})/i,
  );
  const name = embeddedNameMatch?.[1] ? capitalizeWords(embeddedNameMatch[1].trim()) : extractNameGuard(trimmed);
  if (name) details.full_name = name;
  const embeddedPhoneMatch = trimmed.match(/(?:^|[^\d])(\+?34[\s-]?[6789]\d{8}|0034[\s-]?[6789]\d{8}|[6789]\d{8})(?:[^\d]|$)/);
  const phone = embeddedPhoneMatch?.[1] ? extractPhoneGuard(embeddedPhoneMatch[1]) : extractPhoneGuard(trimmed);
  if (phone) details.phone = phone;

  // Service (safe, common booking intents in demos)
  const serviceSignals: Array<{ re: RegExp; value: string }> = [
    { re: /\blimpieza\b/, value: 'limpieza' },
    { re: /\brevision\b/, value: 'revisión' },
    { re: /\bortodoncia\b/, value: 'ortodoncia' },
    { re: /\bblanqueamiento\b/, value: 'blanqueamiento' },
    { re: /\bextraccion\b/, value: 'extracción' },
    { re: /\bimplante\b/, value: 'implante' },
    { re: /\burgenc/i, value: 'urgencia dental' },
  ];
  const service = serviceSignals.find((s) => s.re.test(norm));
  if (service) details.service_type = service.value;

  // Date (very conservative, keeps free-text style used by the system)
  const dayMatch = norm.match(/\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/);
  if (dayMatch) {
    const dayMap: Record<string, string> = {
      lunes: 'lunes',
      martes: 'martes',
      miercoles: 'miércoles',
      jueves: 'jueves',
      viernes: 'viernes',
      sabado: 'sábado',
      domingo: 'domingo',
    };
    details.preferred_date = dayMap[dayMatch[1]] ?? dayMatch[1];
  } else if (/\bmanana\b/.test(norm)) {
    details.preferred_date = 'mañana';
  } else if (/\bhoy\b/.test(norm)) {
    details.preferred_date = 'hoy';
  } else if (/\besta\s+semana\b/.test(norm) || /\besta\s+sem\b/.test(norm)) {
    details.preferred_date = 'esta semana';
  }

  // Time preference: prioritize explicit ranges over generic "mañana" token.
  if (/\bpor\s+la\s+tarde\b/.test(norm)) {
    details.preferred_time = 'afternoon';
  } else if (/\bpor\s+la\s+manana\b/.test(norm)) {
    details.preferred_time = 'morning';
  } else {
    const tp = extractTimePreferenceGuard(trimmed);
    if (tp?.kind === 'value') details.preferred_time = tp.value;
  }

  const status = extractNewOrReturningGuard(trimmed);
  if (status) details.new_or_returning = status;

  const openAvail = extractOpenAvailabilityPreference(trimmed);
  if (openAvail === 'earliest_slot') {
    details.preferred_date = EARLIEST_AVAILABLE_PREFERRED_DATE;
    details.preferred_time = 'flexible';
  } else if (openAvail === 'flexible_time_only') {
    details.preferred_time = 'flexible';
  }

  return details;
}
