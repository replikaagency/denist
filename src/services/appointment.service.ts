import {
  createAppointmentRequest,
  enrichAppointmentRequest,
  getOpenAppointmentRequestForConversation,
  getOpenAppointmentRequestsForContact,
  rescheduleAppointmentRequestRPC,
} from '@/lib/db/appointments';
import { appendConversationEvent } from '@/lib/db/conversation-events';
import { advanceLeadStatus, getLeadById } from '@/lib/db/leads';
import { updateConversation } from '@/lib/db/conversations';
import type { AppointmentRequest, AppointmentType } from '@/types/database';
import type { AppointmentDetails } from '@/lib/conversation/schema';
import { EARLIEST_AVAILABLE_PREFERRED_DATE } from '@/lib/conversation/intake-guards';
import { log } from '@/lib/logger';

// ---------------------------------------------------------------------------
// Normalizers — sanitize LLM free-text before it reaches the DB
// ---------------------------------------------------------------------------

type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'any';

const VALID_TIME_OF_DAY = new Set<string>(['morning', 'afternoon', 'evening', 'any']);

/**
 * Map an arbitrary LLM time string to the DB-allowed enum or null.
 *
 * Strategy (in priority order):
 *   1. Exact match against the four valid values (case-insensitive).
 *   2. Keyword / clock-time heuristics.
 *   3. Bare hour or "a las X" / "at X" — 6–11 → morning, 12–16 → afternoon, 17–23 → evening.
 *   4. null — the invalid value is dropped rather than stored.
 *
 * Examples that map:
 *   "early morning" → 'morning'   "9am" → 'morning'   "a las 8" → 'morning'
 *   "around noon"   → 'afternoon' "2pm" → 'afternoon' "las 14" → 'afternoon'
 *   "after work"    → 'evening'   "6pm" → 'evening'   "17:30" → 'evening'
 *   "anytime"       → 'any'       "flexible" → 'any'
 *
 * Examples that return null (unparseable):
 *   "Tuesday", "right after lunch"
 */
function normalizeTimeOfDay(raw: string | null | undefined): TimeOfDay | null {
  if (!raw) return null;
  const s = raw.toLowerCase().trim();

  if (VALID_TIME_OF_DAY.has(s)) return s as TimeOfDay;

  // Accent-stripped copy for robust Spanish matching.
  // Maps ñ→n, á→a, é→e, í→i, ó→o, ú→u so patterns work regardless of whether
  // the LLM included diacritics (e.g. "mañana" and "manana" both become "manana").
  const sn = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // ── Spanish time-of-day phrases ─────────────────────────────────────────
  //
  // Checked before English keywords so Spanish input never falls through to
  // an incorrect English match.
  //
  // "mañana" ambiguity — "mañana" alone means "tomorrow" (a date), NOT morning.
  // The phrases below are all ANCHORED with "por la", "de la", "las", "primera
  // hora", or "temprano", so bare "mañana" (= normalized "manana") never matches.
  // "mañana por la mañana" hits the 'por la manana' branch ✓
  // "mañana" alone → none of these fire → falls through → returns null ✓

  // Morning
  if (
    sn.includes('por la manana') ||   // por la mañana / por las mañanas
    sn.includes('de la manana') ||    // de la mañana / a las 9 de la mañana (belt)
    sn.includes('por las mananas') || // por las mañanas
    sn.includes('a primera hora') ||  // a primera hora
    sn.includes('manana temprano') || // mañana temprano (LLM extracted as time-of-day)
    sn.includes('temprano')           // temprano / muy temprano
  ) return 'morning';

  // Afternoon
  if (
    sn.includes('por la tarde') ||    // por la tarde / por las tardes
    sn.includes('de la tarde') ||     // de la tarde
    sn.includes('por las tardes') ||  // por las tardes
    sn.includes('mediodia') ||        // mediodía / a mediodía / al mediodía
    sn.includes('medio dia')          // a medio día
  ) return 'afternoon';

  // Evening
  if (
    sn.includes('por la noche') ||    // por la noche
    sn.includes('de la noche') ||     // de la noche / a las 10 de la noche (belt)
    sn.includes('por las noches') ||  // por las noches
    sn.includes('ultima hora')        // a última hora / última hora
  ) return 'evening';

  // ── English keywords ─────────────────────────────────────────────────────

  // Morning: explicit keyword or AM hours 6-11
  if (s.includes('morning') || /\b([6-9]|1[01])\s*am\b/.test(s)) return 'morning';

  // Afternoon: explicit keyword, noon, or clock times 12–4 pm
  if (
    s.includes('afternoon') ||
    s.includes('noon') ||
    s.includes('lunch') ||
    /\b(12|1[2-6]|[1-4])\s*pm\b/.test(s)
  )
    return 'afternoon';

  // Evening: explicit keyword or clock times 5–11 pm
  if (
    s.includes('evening') ||
    s.includes('night') ||
    s.includes('after work') ||
    /\b([5-9]|1[01])\s*pm\b/.test(s)
  )
    return 'evening';

  // Any/flexible
  if (s.includes('any') || s.includes('flexible') || s.includes('anytime')) return 'any';

  // Bare hour or "a las X" / "las X" / "at X" — Spanish/English
  const hourMatch = s.match(/\b(?:a las |las |at )?(\d{1,2})(?:\s*:\s*\d{2})?(?:\s*(?:am|pm|de la mañana|de la tarde|de la noche))?\b/);
  if (hourMatch) {
    const hour = parseInt(hourMatch[1], 10);
    const isPm = /\b(pm|tarde|noche)\b/.test(s);
    if (hour >= 6 && hour <= 11 && !isPm) return 'morning';
    if (hour >= 12 && hour <= 16) return 'afternoon';
    if (hour >= 17 && hour <= 23) return 'evening';
    if ((hour >= 5 && hour <= 11 && isPm) || hour === 0) return 'evening';
  }

  // 24h format HH or HH:mm
  const h24Match = s.match(/\b(\d{1,2})\s*:\s*(\d{2})\b/);
  if (h24Match) {
    const hour = parseInt(h24Match[1], 10);
    if (hour >= 6 && hour <= 11) return 'morning';
    if (hour >= 12 && hour <= 16) return 'afternoon';
    if (hour >= 17 && hour <= 23) return 'evening';
  }

  return null;
}

/**
 * Parse a free-text date string and return a YYYY-MM-DD string or null.
 *
 * Relies on Date.parse, which handles ISO dates, RFC-2822, and many locale
 * formats natively. Relative phrases ("next Monday", "tomorrow") are
 * NOT resolvable without a reference clock — they return null safely rather
 * than guessing.
 *
 * UTC methods are used for formatting to avoid timezone-induced day shifts
 * when the runtime's local offset differs from the patient's.
 *
 * Edge cases handled:
 *   - Already in YYYY-MM-DD → validated and returned as-is.
 *   - Parseable string ("March 20, 2026", "20 Mar 2026") → formatted YYYY-MM-DD.
 *   - Relative / unrecognised text ("next Monday", "soon") → null.
 *   - Empty / null / undefined → null.
 *   - Invalid calendar date ("2026-02-30") → null (Date.parse returns NaN or
 *     rolls over; we re-serialise and compare to catch roll-overs).
 */
function normalizePreferredDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  const ts = Date.parse(trimmed);
  if (isNaN(ts)) return null;

  const d = new Date(ts);
  const year  = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day   = String(d.getUTCDate()).padStart(2, '0');
  const formatted = `${year}-${month}-${day}`;

  // Reject roll-overs: "2026-02-30" parses as March 2 — detect by round-trip.
  // Only applicable when the input was already in YYYY-MM-DD form.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed) && formatted !== trimmed) return null;

  return formatted;
}

const SERVICE_TYPE_TO_APPOINTMENT_TYPE: Record<string, AppointmentType> = {
  // ── New patient (English) ────────────────────────────────────────────────
  'new patient': 'new_patient',
  'new_patient': 'new_patient',
  'new patient exam': 'new_patient',
  'new patient visit': 'new_patient',

  // ── New patient (Spanish) ────────────────────────────────────────────────
  'nuevo paciente': 'new_patient',
  'paciente nuevo': 'new_patient',
  'primera visita': 'new_patient',
  'primera vez': 'new_patient',
  'primera consulta': 'new_patient',
  'primera cita': 'new_patient',

  // ── Check-up / cleaning (English) ───────────────────────────────────────
  cleaning: 'checkup',
  checkup: 'checkup',
  'check-up': 'checkup',
  'check up': 'checkup',
  exam: 'checkup',
  'dental exam': 'checkup',
  'routine exam': 'checkup',
  'routine checkup': 'checkup',
  'routine check-up': 'checkup',

  // ── Check-up / cleaning (Spanish) ───────────────────────────────────────
  limpieza: 'checkup',
  'limpieza dental': 'checkup',
  'limpieza de boca': 'checkup',
  'limpieza bucal': 'checkup',
  'limpiar los dientes': 'checkup',
  'limpieza y revision': 'checkup',
  'limpieza y revisión': 'checkup',
  revisión: 'checkup',
  revision: 'checkup',
  'revisión dental': 'checkup',
  'revision dental': 'checkup',
  'revisión general': 'checkup',
  'revision general': 'checkup',
  chequeo: 'checkup',
  'chequeo dental': 'checkup',
  control: 'checkup',
  'control dental': 'checkup',

  // ── Emergency (English) ──────────────────────────────────────────────────
  'emergency exam': 'emergency',
  emergency: 'emergency',
  'dental emergency': 'emergency',
  'tooth emergency': 'emergency',

  // ── Emergency (Spanish) ──────────────────────────────────────────────────
  urgencia: 'emergency',
  urgencias: 'emergency',
  'urgencia dental': 'emergency',
  'urgencias dentales': 'emergency',
  emergencia: 'emergency',
  'emergencia dental': 'emergency',
  dolor: 'emergency',
  'dolor de muela': 'emergency',
  'dolor de muelas': 'emergency',
  'dolor de diente': 'emergency',
  'dolor dental': 'emergency',

  // ── Whitening (English) ──────────────────────────────────────────────────
  whitening: 'whitening',
  'teeth whitening': 'whitening',
  'tooth whitening': 'whitening',
  bleaching: 'whitening',

  // ── Whitening (Spanish) ──────────────────────────────────────────────────
  blanqueamiento: 'whitening',
  'blanqueamiento dental': 'whitening',
  'blanqueamiento de dientes': 'whitening',
  'blanquear dientes': 'whitening',
  'blanquear los dientes': 'whitening',
  aclaramiento: 'whitening',
  'aclaramiento dental': 'whitening',

  // ── Implants (English) ───────────────────────────────────────────────────
  implant: 'implant_consult',
  'implant consult': 'implant_consult',
  'implant consultation': 'implant_consult',
  'dental implant': 'implant_consult',
  'implant_consult': 'implant_consult',

  // ── Implants (Spanish) ───────────────────────────────────────────────────
  implante: 'implant_consult',
  implantes: 'implant_consult',
  'implante dental': 'implant_consult',
  'implantes dentales': 'implant_consult',
  implantologia: 'implant_consult',
  implantología: 'implant_consult',

  // ── Orthodontics (English) ───────────────────────────────────────────────
  orthodontic: 'orthodontic_consult',
  'orthodontic consult': 'orthodontic_consult',
  'orthodontic consultation': 'orthodontic_consult',
  orthodontics: 'orthodontic_consult',
  'orthodontic_consult': 'orthodontic_consult',
  braces: 'orthodontic_consult',
  invisalign: 'orthodontic_consult',
  aligner: 'orthodontic_consult',
  aligners: 'orthodontic_consult',

  // ── Orthodontics (Spanish) ───────────────────────────────────────────────
  ortodoncia: 'orthodontic_consult',
  brackets: 'orthodontic_consult',
  bracket: 'orthodontic_consult',
  aparato: 'orthodontic_consult',
  'aparato dental': 'orthodontic_consult',
  aparatos: 'orthodontic_consult',
  'aparatos dentales': 'orthodontic_consult',
  alineadores: 'orthodontic_consult',
  alineador: 'orthodontic_consult',
  'invisalign ortodoncia': 'orthodontic_consult',

  // ── Other treatments (Spanish) — no dedicated type yet; map explicitly so
  //    intent is clear and future enum additions can update just this table ─
  empaste: 'other',
  empastes: 'other',
  obturación: 'other',
  obturacion: 'other',
  caries: 'other',
  'tapar caries': 'other',
  extracción: 'other',
  extraccion: 'other',
  'extracción dental': 'other',
  'extraccion dental': 'other',
  'sacar muela': 'other',
  'sacar muelas': 'other',
  'sacar diente': 'other',
  'muela del juicio': 'other',
  'muelas del juicio': 'other',
  cordales: 'other',
  endodoncia: 'other',
  endodoncias: 'other',
  'matar nervio': 'other',
  'matar el nervio': 'other',
  conductos: 'other',
  'tratamiento de conductos': 'other',
  corona: 'other',
  coronas: 'other',
  funda: 'other',
  fundas: 'other',
  porcelana: 'other',
  periodoncia: 'other',
  'encías': 'other',
  encias: 'other',
  piorrea: 'other',
  carillas: 'other',
  'carillas de porcelana': 'other',
};

function resolveAppointmentType(serviceType: string | null): AppointmentType {
  if (!serviceType) return 'other';
  const normalized = serviceType.toLowerCase().trim();
  return SERVICE_TYPE_TO_APPOINTMENT_TYPE[normalized] ?? 'other';
}

// ---------------------------------------------------------------------------
// Resolved field bundle — computed once, reused by create and enrich paths
// ---------------------------------------------------------------------------

interface ResolvedFields {
  appointment_type: AppointmentType;
  preferred_date: string | null;
  preferred_time_of_day: TimeOfDay | null;
  notes: string | null;
  /** Fallback text when time/date could not be normalized; used for notes merge on enrich */
  notesFallback: string | null;
}

const MAX_RAW_PREFERENCE_LENGTH = 100;

/** Fallback text for time/date that could not be normalized. Preserved in notes. */
function getNotesFallback(appointment: Partial<AppointmentDetails>): string | null {
  const parts: string[] = [];
  const rawTime = appointment.preferred_time?.trim();
  if (rawTime && !normalizeTimeOfDay(rawTime)) {
    parts.push(`Patient preferred time: ${rawTime.slice(0, MAX_RAW_PREFERENCE_LENGTH)}`);
  }
  const rawDate = appointment.preferred_date?.trim();
  if (rawDate && !normalizePreferredDate(rawDate)) {
    parts.push(`Patient preferred date: ${rawDate.slice(0, MAX_RAW_PREFERENCE_LENGTH)}`);
  }
  return parts.length > 0 ? parts.join('; ') : null;
}

function buildNotes(appointment: Partial<AppointmentDetails>): string | null {
  const parts: string[] = [];

  if (appointment.preferred_provider?.trim()) {
    parts.push(`Preferred provider: ${appointment.preferred_provider.trim().slice(0, MAX_RAW_PREFERENCE_LENGTH)}`);
  }

  const fallback = getNotesFallback(appointment);
  if (fallback) parts.push(fallback);

  return parts.length > 0 ? parts.join('; ') : null;
}

function resolveFields(appointment: Partial<AppointmentDetails>): ResolvedFields {
  return {
    appointment_type: resolveAppointmentType(appointment.service_type ?? null),
    preferred_date: normalizePreferredDate(appointment.preferred_date),
    preferred_time_of_day: normalizeTimeOfDay(appointment.preferred_time),
    notes: buildNotes(appointment),
    notesFallback: getNotesFallback(appointment),
  };
}

/**
 * Returns true only when appointment data is complete enough to create a
 * pending DB record satisfying migration 0005 constraints:
 *   - service_type known (not null)
 *   - preferred_time resolves to a valid time-of-day bucket
 *   - at least one date anchor: preferred_date OR preferred_days non-empty
 *
 * preferredDays is a DB-only field not currently in AppointmentDetails;
 * it's accepted here so the OR logic matches the DB constraint exactly
 * and is ready when the LLM schema is extended.
 */
export function isAppointmentDataComplete(
  appointment: Partial<AppointmentDetails>,
  preferredDays?: string[],
): boolean {
  if (!appointment.service_type) return false;
  if (!normalizeTimeOfDay(appointment.preferred_time)) return false;
  const rawDate = appointment.preferred_date?.trim().toLowerCase() ?? '';
  const hasDate =
    !!normalizePreferredDate(appointment.preferred_date) ||
    rawDate === EARLIEST_AVAILABLE_PREFERRED_DATE;
  const hasDays = Array.isArray(preferredDays) && preferredDays.length > 0;
  return hasDate || hasDays;
}

/**
 * Return the active (pending or confirmed) appointment request for this
 * conversation, or null if none exists.
 * Exposed here so callers in chat.service.ts can make explicit branching
 * decisions without depending on createRequest() internals.
 */
export async function findOpenAppointmentRequest(
  conversationId: string,
): Promise<AppointmentRequest | null> {
  return getOpenAppointmentRequestForConversation(conversationId);
}

/**
 * Build a patch that fills in missing fields on an existing row using better
 * data from a later turn.  Rules:
 *
 * Normal (fill-null) path — runs for every trigger:
 *   - appointment_type: upgrade from 'other' only — never overwrite a
 *     specific type with a different specific type.
 *   - preferred_date / preferred_time_of_day / notes: fill in if currently null.
 *
 * Correction (overwrite) path — only when correctionFields is non-empty:
 *   - preferred_date:       overwrite if 'preferred_date' is in correctionFields
 *                           and the resolved value differs from the existing one.
 *   - preferred_time_of_day: overwrite if 'preferred_time' is in correctionFields
 *                           (note: correction field name is 'preferred_time';
 *                            DB column is preferred_time_of_day).
 *   - appointment_type:     overwrite if 'service_type' is in correctionFields
 *                           and the resolved type is specific (not 'other').
 *   - notes:                overwrite if 'preferred_provider' is in correctionFields
 *                           (provider is the only field that maps 1:1 to notes).
 */
function buildEnrichPatch(
  existing: AppointmentRequest,
  resolved: ResolvedFields,
  correctionFields?: string[],
): Partial<ResolvedFields> | null {
  const patch: Partial<ResolvedFields> = {};
  const corrected = (field: string) => correctionFields?.includes(field) ?? false;

  // appointment_type — fill from 'other' (normal) or overwrite if service_type corrected
  if (existing.appointment_type === 'other' && resolved.appointment_type !== 'other') {
    patch.appointment_type = resolved.appointment_type;
  } else if (
    corrected('service_type') &&
    resolved.appointment_type !== 'other' &&
    resolved.appointment_type !== existing.appointment_type
  ) {
    patch.appointment_type = resolved.appointment_type;
  }

  // preferred_date — fill-null (normal) or overwrite if corrected
  if (!existing.preferred_date && resolved.preferred_date) {
    patch.preferred_date = resolved.preferred_date;
  } else if (
    corrected('preferred_date') &&
    resolved.preferred_date &&
    resolved.preferred_date !== existing.preferred_date
  ) {
    patch.preferred_date = resolved.preferred_date;
  }

  // preferred_time_of_day — fill-null (normal) or overwrite if corrected
  // correction_fields uses 'preferred_time'; DB column is preferred_time_of_day
  if (!existing.preferred_time_of_day && resolved.preferred_time_of_day) {
    patch.preferred_time_of_day = resolved.preferred_time_of_day;
  } else if (
    corrected('preferred_time') &&
    resolved.preferred_time_of_day &&
    resolved.preferred_time_of_day !== existing.preferred_time_of_day
  ) {
    patch.preferred_time_of_day = resolved.preferred_time_of_day;
  }

  // notes — fill-null (normal)
  if (!existing.notes && resolved.notes) {
    patch.notes = resolved.notes;
  }
  // Merge fallback when existing notes already has content (e.g. provider) but we have
  // new raw time/date that could not be normalized. Prefix check ('Patient preferred')
  // prevents accumulation across turns: once any fallback entry is present, subsequent
  // turns with different unparseable values do not append a second entry.
  if (existing.notes && resolved.notesFallback && !existing.notes.includes('Patient preferred')) {
    patch.notes = `${existing.notes}; ${resolved.notesFallback}`;
  }
  // Overwrite notes only when preferred_provider is explicitly corrected
  if (corrected('preferred_provider') && resolved.notes !== existing.notes) {
    patch.notes = resolved.notes;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Create an appointment request from engine output.
 * Advances the lead to `appointment_requested`.
 *
 * Idempotent per conversation: if a pending or confirmed request already
 * exists for this conversation, returns it without creating a duplicate.
 * This prevents the engine from creating multiple rows when `offer_appointment`
 * fires on consecutive turns.
 *
 * Enrichment: if the existing row has incomplete data (e.g. it was created on
 * an early `confirm_details` turn before the patient had provided all fields),
 * any null/degraded fields are updated with the more complete values now
 * available.  Specifically:
 *   - appointment_type is upgraded from 'other' once the service type is known.
 *   - preferred_date, preferred_time_of_day, notes are filled if still null.
 *
 * Race-safe: a partial unique index on (conversation_id) WHERE status IN
 * ('pending','confirmed') is the DB-level backstop. If two concurrent requests
 * slip past the app-level check simultaneously, the second insert will fail
 * with a unique constraint violation. We catch that, re-query for the winner,
 * and apply the same enrichment logic to it.
 *
 * Note on cancelled requests: the dedup guard intentionally ignores rows with
 * status='cancelled'. If staff cancel a request, the engine is allowed to
 * create a new one for the same conversation on the next `offer_appointment`
 * turn.
 */
export async function createRequest(input: {
  contactId: string;
  conversationId: string;
  leadId: string;
  appointment: Partial<AppointmentDetails>;
  /** When the turn is a correction, pass the LLM's correction_fields so
   *  buildEnrichPatch can overwrite existing non-null values instead of
   *  skipping them.  Omit (or pass undefined) on normal turns. */
  correctionFields?: string[];
}): Promise<AppointmentRequest> {
  const resolved = resolveFields(input.appointment);

  const existing = await getOpenAppointmentRequestForConversation(input.conversationId);
  if (existing) {
    const patch = buildEnrichPatch(existing, resolved, input.correctionFields);
    if (patch) {
      const updated = await enrichAppointmentRequest(existing.id, patch);
      log('info', 'appointment.request_updated', {
        appointment_id: existing.id,
        conversationId: input.conversationId,
        patch_fields: Object.keys(patch),
      });
      return updated;
    }
    return existing;
  }

  const { notesFallback: _drop, ...dbFields } = resolved;
  let request: AppointmentRequest;
  try {
    request = await createAppointmentRequest({
      contact_id: input.contactId,
      conversation_id: input.conversationId,
      lead_id: input.leadId,
      ...dbFields,
    });
    appendConversationEvent({
      conversationId: input.conversationId,
      contactId: input.contactId,
      leadId: input.leadId,
      eventType: 'appointment_request_created',
      source: 'chat',
      metadata: {
        appointment_request_id: request.id,
        appointment_status: request.status,
        appointment_type: request.appointment_type,
      },
    });
    log('info', 'appointment.request_created', {
      appointment_id: request.id,
      conversationId: input.conversationId,
      contactId: input.contactId,
      appointment_type: resolved.appointment_type,
    });
  } catch (err) {
    // A concurrent request may have inserted between our check and this insert.
    // Re-query and apply enrichment to the winner rather than propagating the
    // constraint error.
    const raceWinner = await getOpenAppointmentRequestForConversation(input.conversationId);
    if (raceWinner) {
      const patch = buildEnrichPatch(raceWinner, resolved, input.correctionFields);
      if (patch) {
        const updated = await enrichAppointmentRequest(raceWinner.id, patch);
        log('info', 'appointment.request_updated', {
          appointment_id: raceWinner.id,
          conversationId: input.conversationId,
          patch_fields: Object.keys(patch),
        });
        return updated;
      }
      return raceWinner;
    }
    log('error', 'appointment.create_request_race_recovery_failed', {
      conversationId: input.conversationId,
      contactId: input.contactId,
      error: err instanceof Error ? err.message : err,
    });
    throw err;
  }

  // Only advance to appointment_requested if the lead hasn't already passed this
  // milestone. This prevents a re-opened appointment from downgrading a lead
  // that's already at booked, lost, or disqualified.
  const STATUS_RANK: Record<string, number> = {
    new: 0, contacted: 1, qualified: 2, appointment_requested: 3,
    booked: 4, lost: 5, disqualified: 5,
  };
  const currentLead = await getLeadById(input.leadId);
  if ((STATUS_RANK[currentLead.status] ?? 0) < STATUS_RANK['appointment_requested']) {
    await advanceLeadStatus(input.contactId, 'appointment_requested');
  }
  await updateConversation(input.conversationId, { lead_id: input.leadId });

  return request;
}

// ---------------------------------------------------------------------------
// Reschedule support
// ---------------------------------------------------------------------------

/**
 * Return all open (pending | confirmed) requests for a contact across ALL
 * conversations. Used by the reschedule flow so the patient can pick which
 * appointment to change, even if it was created in a different chat session.
 */
export async function findOpenRequestsForContact(
  contactId: string,
): Promise<AppointmentRequest[]> {
  return getOpenAppointmentRequestsForContact(contactId);
}

const APPOINTMENT_TYPE_DISPLAY: Record<string, string> = {
  new_patient:          'Primera visita',
  checkup:              'Limpieza / revisión',
  emergency:            'Urgencia',
  whitening:            'Blanqueamiento',
  implant_consult:      'Consulta implantes',
  orthodontic_consult:  'Consulta ortodoncia',
  other:                'Otro tratamiento',
};

const TIME_OF_DAY_DISPLAY: Record<string, string> = {
  morning:   'por la mañana',
  afternoon: 'por la tarde',
  evening:   'por la noche',
  any:       'horario flexible',
};

/**
 * Build a short patient-facing summary of an appointment request, e.g.
 * "Limpieza / revisión — martes 22 de julio — por la mañana"
 */
export function summarizeRequest(req: AppointmentRequest): string {
  const typeName = APPOINTMENT_TYPE_DISPLAY[req.appointment_type] ?? req.appointment_type;
  const parts: string[] = [typeName];

  if (req.preferred_date) {
    const d = new Date(req.preferred_date + 'T00:00:00Z');
    parts.push(
      d.toLocaleDateString('es-ES', {
        weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
      }),
    );
  }

  if (req.preferred_time_of_day) {
    parts.push(TIME_OF_DAY_DISPLAY[req.preferred_time_of_day] ?? req.preferred_time_of_day);
  }

  return parts.join(' — ');
}

/**
 * Execute the atomic reschedule: cancel the old appointment_request and create
 * the new one in a single Postgres transaction via the Supabase RPC.
 *
 * Returns the newly created AppointmentRequest row. Throws typed AppErrors for
 * the two expected failure modes (not found, already closed) so the caller can
 * apply a graceful fallback without parsing raw error strings.
 */
export async function executeReschedule(input: {
  oldRequestId: string;
  contactId: string;
  conversationId: string;
  leadId: string;
  appointment: Partial<AppointmentDetails>;
}): Promise<AppointmentRequest> {
  const resolved = resolveFields(input.appointment);

  await rescheduleAppointmentRequestRPC({
    oldRequestId:      input.oldRequestId,
    contactId:         input.contactId,
    conversationId:    input.conversationId,
    leadId:            input.leadId,
    appointmentType:   resolved.appointment_type,
    preferredDate:     resolved.preferred_date,
    preferredTimeOfDay: resolved.preferred_time_of_day,
    notes:             resolved.notes,
  });

  // Fetch the fresh row that the RPC created.
  const newRow = await getOpenAppointmentRequestForConversation(input.conversationId);
  if (!newRow) {
    throw new Error(
      `Reschedule RPC succeeded but new row not found (conversation=${input.conversationId})`,
    );
  }

  appendConversationEvent({
    conversationId: input.conversationId,
    contactId: input.contactId,
    leadId: input.leadId,
    eventType: 'appointment_request_created',
    source: 'chat',
    metadata: {
      appointment_request_id: newRow.id,
      prior_appointment_request_id: input.oldRequestId,
      path: 'reschedule',
      appointment_status: newRow.status,
    },
  });

  log('info', 'appointment.request_rescheduled', {
    old_id: input.oldRequestId,
    new_id: newRow.id,
    conversationId: input.conversationId,
  });

  return newRow;
}
