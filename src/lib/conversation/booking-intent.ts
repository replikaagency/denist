/**
 * Canonical handling for vague “as soon as possible” booking intents.
 * Maps free-text to ASAP flow + deterministic slot proposals (mock calendar until wired to real API).
 */

import { extractOpenAvailabilityPreference } from './intake-guards';
import type { ConversationState } from './schema';
import { logConversationFlow } from '@/lib/logger/flow-logger';
import { getNextAvailableSlots, type ExistingAppointmentWindow } from './booking.service';

export const ASAP_INTENT = true as const;

export type AsapSlotProposal = {
  /** Stable id for metadata / tests */
  id: string;
  /** One line for the patient, e.g. "Mar 26, 10:00" */
  displayLine: string;
  /** YYYY-MM-DD for appointment.preferred_date */
  isoDate: string;
  /** Value for appointment.preferred_time (must pass normalizeTimeOfDay) */
  preferredTime: string;
};

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

/**
 * True when the patient wants the earliest possible appointment (ASAP),
 * including phrases handled elsewhere as "earliest_slot" open availability.
 */
export function detectAsapBookingIntent(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;
  if (extractOpenAvailabilityPreference(trimmed) === 'earliest_slot') return true;

  const n = stripAccents(trimmed);

  const patterns: RegExp[] = [
    /\bcuando\s+pueda?s?\b/,
    /\bcuando\s+pode(is|is)\b/,
    /\bcuanto\s+antes\b/,
    /\blo\s+antes\s+posible\b/,
    /\bprimer[ao]?\s+disponib/,
    /\bprimera\s+cita\s+disponib/,
    /\blo\s+primero\s+que\s+(pueda|haya|podais|podáis)\b/,
    /\ben\s+cuanto\s+antes\b/,
    /\bcualquier\s+(dia|día)\s+me\s+vale\b/,
    /\bme\s+da\s+igual\s+el\s+dia\b/,
    /\bavisadme\s+cuando\s+haya\b/,
    /\bque\s+sea\s+pronto\b/,
    /\bpara\s+ya\b/,
    /\bpara\s+cuanto\s+antes\b/,
  ];

  return patterns.some((re) => re.test(n));
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatDisplayLine(d: Date, hour: number, minute: number): string {
  const datePart = d.toLocaleDateString('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  });
  return `${datePart}, ${pad2(hour)}:${pad2(minute)}`;
}

function hourToPreferredTime(hour: number): string {
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

export function fetchNextAsapSlots(
  count: number,
  _from: Date = new Date(),
  existingAppointments: ExistingAppointmentWindow[] = [],
): AsapSlotProposal[] {
  const slots = getNextAvailableSlots({
    desired_type: 'asap',
    existing_appointments: existingAppointments,
  }).slice(0, count);

  return slots.map((slot) => {
    const d = new Date(slot.datetime);
    const y = d.getUTCFullYear();
    const mo = pad2(d.getUTCMonth() + 1);
    const da = pad2(d.getUTCDate());
    const isoDate = `${y}-${mo}-${da}`;
    return {
      id: slot.id,
      displayLine: slot.label || formatDisplayLine(d, d.getUTCHours(), d.getUTCMinutes()),
      isoDate,
      preferredTime: hourToPreferredTime(d.getUTCHours()),
    };
  });
}

export type AsapProposalsFlowLog = {
  conversation_id: string;
  phone: string | null;
  input: string;
};

export function buildAsapSlotProposals(
  count = 3,
  from?: Date,
  flowLog?: AsapProposalsFlowLog,
): AsapSlotProposal[] {
  const proposals = fetchNextAsapSlots(count, from, []);
  if (flowLog) {
    logConversationFlow({
      conversation_id: flowLog.conversation_id,
      phone: flowLog.phone,
      step: 'booking',
      input: flowLog.input,
      branch_taken: 'asap_proposals_built',
      reason: `slot_count=${proposals.length}`,
    });
  }
  return proposals;
}

/** 0-based index, or null. Accepts 1/2/3, tokens `asap_slot_0`, button values. */
export function parseAsapSlotChoice(text: string): number | null {
  const raw = text.trim().toLowerCase();
  const t = stripAccents(raw).replace(/\s+/g, '');
  const m = /^asap_slot_([0-2])$/.exec(t);
  if (m) return Number(m[1]);

  if (/^(1|1\.|1\))$/.test(t)) return 0;
  if (/^(2|2\.|2\))$/.test(t)) return 1;
  if (/^(3|3\.|3\))$/.test(t)) return 2;
  return null;
}

export function applyAsapSlotProposalToState(state: ConversationState, proposal: AsapSlotProposal): void {
  state.appointment.preferred_date = proposal.isoDate;
  state.appointment.preferred_time = proposal.preferredTime;
  state.appointment.flexibility = state.appointment.flexibility ?? 'somewhat_flexible';
}
