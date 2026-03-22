/**
 * Deterministic signals for hybrid booking: patient describes availability
 * without a concrete calendar date (handled separately from LLM hybrid_booking JSON).
 */

export function detectAvailabilityStyleMessage(text: string): boolean {
  const t = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  if (t.length < 4) return false;

  const patterns: RegExp[] = [
    /\b(solo|solamente)\s+(por\s+las\s+)?(mananas?|tardes?|noches?)\b/,
    /\b(solo|solamente)\b.{0,40}\bpor\s+las\s+(mananas?|tardes?|noches?)\b/,
    /\b(solo|solamente)\s+(el\s+|los\s+)?(lunes|martes|miercoles|jueves|viernes|sabados?|domingos?)\b/,
    /\ba\s+partir\s+de\s+las\s+\d{1,2}/,
    /\b(desde\s+las|a\s+las)\s+\d{1,2}\s*[:h]?\s*\d{0,2}\b/,
    /\bavisadme\b.*\b(hueco|plaza|sitio|cita)\b/,
    /\b(si\s+)?queda\s+(un\s+)?hueco\b/,
    /\bcualquier\s+hueco\b/,
    /\bme\s+avis(ais|áis|an)\b/,
    /\bavisar\s+si\s+hay\b/,
  ];

  return patterns.some((p) => p.test(t));
}
