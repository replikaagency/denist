import {
  createAppointmentRequest,
  enrichAppointmentRequest,
  getOpenAppointmentRequestForConversation,
} from '@/lib/db/appointments';
import { advanceLeadStatus, getLeadById } from '@/lib/db/leads';
import { updateConversation } from '@/lib/db/conversations';
import type { AppointmentRequest, AppointmentType } from '@/types/database';
import type { AppointmentDetails } from '@/lib/conversation/schema';

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
  // New patient variants
  'new patient': 'new_patient',
  'new_patient': 'new_patient',
  'new patient exam': 'new_patient',
  'new patient visit': 'new_patient',

  // Check-up / cleaning variants
  cleaning: 'checkup',
  checkup: 'checkup',
  'check-up': 'checkup',
  'check up': 'checkup',
  exam: 'checkup',
  'dental exam': 'checkup',
  'routine exam': 'checkup',
  'routine checkup': 'checkup',
  'routine check-up': 'checkup',

  // Emergency variants
  'emergency exam': 'emergency',
  emergency: 'emergency',
  'dental emergency': 'emergency',
  'tooth emergency': 'emergency',

  // Whitening variants
  whitening: 'whitening',
  'teeth whitening': 'whitening',
  'tooth whitening': 'whitening',
  bleaching: 'whitening',

  // Implant variants
  implant: 'implant_consult',
  'implant consult': 'implant_consult',
  'implant consultation': 'implant_consult',
  'dental implant': 'implant_consult',
  'implant_consult': 'implant_consult',

  // Orthodontic variants
  orthodontic: 'orthodontic_consult',
  'orthodontic consult': 'orthodontic_consult',
  'orthodontic consultation': 'orthodontic_consult',
  orthodontics: 'orthodontic_consult',
  'orthodontic_consult': 'orthodontic_consult',
  braces: 'orthodontic_consult',
  invisalign: 'orthodontic_consult',
  aligner: 'orthodontic_consult',
  aligners: 'orthodontic_consult',
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
  const hasDate = !!normalizePreferredDate(appointment.preferred_date);
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
 *   - appointment_type: upgrade from 'other' only — never overwrite a
 *     specific type with a different specific type.
 *   - preferred_date / preferred_time_of_day / notes: fill in if currently
 *     null and the new value is non-null.
 */
function buildEnrichPatch(
  existing: AppointmentRequest,
  resolved: ResolvedFields,
): Partial<ResolvedFields> | null {
  const patch: Partial<ResolvedFields> = {};

  if (existing.appointment_type === 'other' && resolved.appointment_type !== 'other') {
    patch.appointment_type = resolved.appointment_type;
  }
  if (!existing.preferred_date && resolved.preferred_date) {
    patch.preferred_date = resolved.preferred_date;
  }
  if (!existing.preferred_time_of_day && resolved.preferred_time_of_day) {
    patch.preferred_time_of_day = resolved.preferred_time_of_day;
  }
  if (!existing.notes && resolved.notes) {
    patch.notes = resolved.notes;
  }
  // Merge fallback when existing notes already has content (e.g. provider) but we have new raw time/date
  if (existing.notes && resolved.notesFallback && !existing.notes.includes(resolved.notesFallback)) {
    patch.notes = `${existing.notes}; ${resolved.notesFallback}`;
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
}): Promise<AppointmentRequest> {
  const resolved = resolveFields(input.appointment);

  const existing = await getOpenAppointmentRequestForConversation(input.conversationId);
  if (existing) {
    const patch = buildEnrichPatch(existing, resolved);
    if (patch) return enrichAppointmentRequest(existing.id, patch);
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
  } catch (err) {
    // A concurrent request may have inserted between our check and this insert.
    // Re-query and apply enrichment to the winner rather than propagating the
    // constraint error.
    const raceWinner = await getOpenAppointmentRequestForConversation(input.conversationId);
    if (raceWinner) {
      const patch = buildEnrichPatch(raceWinner, resolved);
      if (patch) return enrichAppointmentRequest(raceWinner.id, patch);
      return raceWinner;
    }
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
