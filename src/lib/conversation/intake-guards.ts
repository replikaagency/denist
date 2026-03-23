// ---------------------------------------------------------------------------
// Boolean guards (yes/no)
// ---------------------------------------------------------------------------

/**
 * Returns true if the message is a clear "yes" (Spanish or English, robust to accents).
 */
export function isYes(message: string): boolean {
  const norm = removeDiacritics(message.trim().toLowerCase());
  return /^(si|sí|s|yes|y|claro|vale|ok|de acuerdo|por supuesto|correcto|afirmativo|eso es|exacto|cierto|seguro|ajá|aha|así es|así|asi|perfecto|efectivamente)[.!?\s]*$/i.test(norm);
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
  if (!normalized || normalized.length > 100) return null;

  // Pattern 1: explicit prefix → high confidence
  const prefixMatch = normalized.match(
    /(?:me\s+llamo|mi\s+nombre\s+es|soy|llámame|llamame|me\s+llaman)\s+([A-ZÁÉÍÓÚÜÑA-Za-záéíóúüñ][a-záéíóúüñA-ZÁÉÍÓÚÜÑ]+(?:\s+[A-ZÁÉÍÓÚÜÑA-Za-záéíóúüñ][a-záéíóúüñA-ZÁÉÍÓÚÜÑ]+)*)/i,
  );
  if (prefixMatch?.[1]) {
    const name = prefixMatch[1].trim();
    if (name.length >= 2 && !/\d/.test(name)) {
      return capitalizeWords(name);
    }
  }

  // Pattern 2: bare name — 2–4 alpha-only words, each ≥2 chars, no stop words
  // Requires ≥2 words to avoid single-word ambiguities like "sí" or "nuevo"
  if (/^[a-záéíóúüñA-ZÁÉÍÓÚÜÑ\s']+$/.test(normalized)) {
    const words = normalized.split(/\s+/).filter(Boolean);
    if (words.length >= 2 && words.length <= 4) {
      const allValid = words.every(
        (w) => /^[a-záéíóúüñA-ZÁÉÍÓÚÜÑ']+$/.test(w) && w.length >= 2,
      );
      const noStopWords = words.every(
        (w) => !SPANISH_NAME_STOP_WORDS.has(removeDiacritics(w.toLowerCase())),
      );
      if (allValid && noStopWords) {
        return capitalizeWords(normalized);
      }
    }
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

  // Normalise: remove spaces and dashes for whole-message checks
  const stripped = message.replace(/[\s\-\.]/g, '');

  // +34 prefix
  const withPlus = stripped.match(/^\+34([6789]\d{8})$/);
  if (withPlus) return `+34${withPlus[1]}`;

  // 0034 prefix
  const with0034 = stripped.match(/^0034([6789]\d{8})$/);
  if (with0034) return `+34${with0034[1]}`;

  // Bare 9-digit Spanish number (only digits + optional separators in whole message)
  const bare = stripped.match(/^([6789]\d{8})$/);
  if (bare) return bare[1];

  // Embedded in sentence: "mi número es 612 34 56 78", "llámame al 666 777 888"
  const inSentence = message.match(
    /(?:es|al|número|numero|teléfono|telefono|tel\.?|telf\.?|móvil|movil|cel\.?|:)\s*(\+?34\s?)?([6789][\s\d]{9,13})/i,
  );
  if (inSentence) {
    const prefix = (inSentence[1] ?? '').replace(/\D/g, '');
    const raw = inSentence[2].replace(/\s/g, '');
    const digits = prefix + raw;
    if (/^(34)?[6789]\d{8}$/.test(digits)) {
      return digits.startsWith('34') ? `+${digits}` : digits;
    }
  }

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

  const RETURNING_SIGNALS = [
    'ya soy paciente', 'soy paciente', 'ya vengo', 'ya he venido', 'ya he ido',
    'vuelvo', 'de siempre', 'tengo ficha', 'tengo historial', 'ya estoy',
    'paciente vuestro', 'paciente suyo', 'ya os conozco', 'ya los conozco',
    'hace tiempo que vengo', 'llevo tiempo', 'sigo siendo',
  ];

  const NEW_SIGNALS = [
    'primera vez', 'es la primera', 'nunca he venido', 'nunca he ido',
    'no he venido', 'no he ido antes', 'soy nuevo', 'soy nueva',
    'nunca antes', 'primera visita', 'nunca he estado',
  ];

  for (const signal of RETURNING_SIGNALS) {
    if (norm.includes(removeDiacritics(signal))) return 'returning';
  }
  for (const signal of NEW_SIGNALS) {
    if (norm.includes(removeDiacritics(signal))) return 'new';
  }

  return null;
}
