/**
 * Deterministic signals for hybrid booking: patient describes availability
 * without a concrete calendar date (handled separately from LLM hybrid_booking JSON).
 */

function normalizeForDetection(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

export interface HybridTextHints {
  service_interest: string | null;
  preferred_days: string[];
  preferred_time_ranges: string[];
}

/**
 * Deterministic extraction when the model omits hybrid_booking fields but the patient
 * states service + availability in one message (Spanish).
 */
export function extractHybridAvailabilityHintsFromText(raw: string): HybridTextHints {
  const t = normalizeForDetection(raw);

  const preferred_days: string[] = [];
  const dayChecks: [RegExp, string][] = [
    [/\blunes\b/, 'lunes'],
    [/\bmartes\b/, 'martes'],
    [/\bmiercoles\b/, 'miércoles'],
    [/\bjueves\b/, 'jueves'],
    [/\bviernes\b/, 'viernes'],
    [/\bsabados?\b/, 'sábado'],
    [/\bdomingos?\b/, 'domingo'],
  ];
  for (const [re, label] of dayChecks) {
    if (re.test(t) && !preferred_days.includes(label)) preferred_days.push(label);
  }

  const preferred_time_ranges: string[] = [];
  const addRange = (s: string) => {
    if (!preferred_time_ranges.includes(s)) preferred_time_ranges.push(s);
  };
  if (/\b(por\s+las\s+)?mananas?\b/.test(t) || /\bpor\s+la\s+manana\b/.test(t)) {
    addRange('por la mañana');
  }
  if (/\b(por\s+las\s+)?tardes?\b/.test(t) || /\bpor\s+la\s+tarde\b/.test(t)) {
    addRange('por la tarde');
  }
  if (/\b(por\s+las\s+)?noches?\b/.test(t) || /\bpor\s+la\s+noche\b/.test(t)) {
    addRange('por la noche');
  }
  const apartir = t.match(/\ba\s+partir\s+de\s+las\s+(\d{1,2}(?:[:h.]\d{2})?)\b/);
  if (apartir) {
    const clock = apartir[1].replace('h', ':');
    addRange(`a partir de las ${clock}`);
  }
  const desde = t.match(/\b(desde\s+las|a\s+las)\s+(\d{1,2}(?:[:h.]\d{2})?)\b/);
  if (desde) {
    addRange(`${desde[1]} ${desde[2]}`);
  }

  const service_interest = extractServiceInterestFromText(raw);

  return { service_interest, preferred_days, preferred_time_ranges };
}

function extractServiceInterestFromText(text: string): string | null {
  const knownRe =
    /\b(ortodoncia|implantes?|limpieza(?:s)?|endodoncia|extracci[oó]n(?:es)?|blanqueamiento|coronas?|empastes?|revisi[oó]n(?:es)?|carillas?|pr[oó]tesis|enc[ií]as|bruxismo)\b/i;
  const km = text.match(knownRe);
  if (km) return km[0];

  const qm = text.match(/\bquiero\s+([^\n,.]{2,70}?)(?=\s*[,.]|$|\s+pero|\s+y\s+)/i);
  if (qm) {
    const phrase = qm[1].trim();
    if (phrase.length >= 3 && !/^(una\s+)?cita$/i.test(phrase)) return phrase;
  }
  return null;
}

export function detectAvailabilityStyleMessage(text: string): boolean {
  const t = normalizeForDetection(text);
  if (t.length < 4) return false;

  const patterns: RegExp[] = [
    /\b(solo|solamente)\s+(por\s+las\s+)?(mananas?|tardes?|noches?)\b/,
    /\b(solo|solamente)\b.{0,40}\bpor\s+las\s+(mananas?|tardes?|noches?)\b/,
    /\b(solo|solamente)\s+(el\s+|los\s+)?(lunes|martes|miercoles|jueves|viernes|sabados?|domingos?)\b/,
    /\bpor\s+la\s+(manana|tarde|noche)\b/,
    /\bpor\s+las\s+(mananas?|tardes?|noches?)\b/,
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
