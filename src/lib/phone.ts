/**
 * Normalize a phone number to E.164 format for Spain (+34XXXXXXXXX).
 *
 * All of these map to the same canonical value:
 *   "666666666"        → "+34666666666"
 *   "666 666 666"      → "+34666666666"
 *   "+34 666 666 666"  → "+34666666666"
 *   "0034 666666666"   → "+34666666666"
 *
 * Numbers that don't match a known Spanish pattern are returned unchanged
 * so the function never throws and never corrupts foreign numbers.
 */
export function normalizePhone(raw: string): string {
  if (!raw || typeof raw !== 'string') return raw;

  const digits = raw.replace(/\D/g, '');

  // "0034XXXXXXXXX" — 13 digits, international exit code for Spain
  if (digits.startsWith('0034') && digits.length === 13) {
    return '+' + digits.slice(2); // drop "00", keep "34XXXXXXXXX"
  }

  // "34XXXXXXXXX" — 11 digits, country code already present, no prefix
  if (digits.startsWith('34') && digits.length === 11) {
    return '+' + digits;
  }

  // "6XXXXXXXX" / "7XXXXXXXX" / "8XXXXXXXX" / "9XXXXXXXX" — bare 9-digit Spanish number
  if (digits.length === 9 && /^[6789]/.test(digits)) {
    return '+34' + digits;
  }

  // Unknown format — return as-is
  return raw;
}
