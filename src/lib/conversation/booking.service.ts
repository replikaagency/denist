/**
 * Booking / scheduling helpers: path parsing, draft reset, reschedule list selection, LLM history shape.
 */

import { getNextFieldPrompt, fieldQueryOptionsFromState } from '@/lib/conversation/fields';
import type { ConversationState } from '@/lib/conversation/schema';
import type { Message } from '@/types/database';
import type { ChatMessage } from '@/lib/ai/completion';
import type { AppointmentDetails } from '@/lib/conversation/schema';

export function isQuickBookingEntryIntent(text: string): boolean {
  const t = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  return (
    t === 'quick_booking_start' ||
    t === 'quick_booking_fast' ||
    /^(reservar|agendar)$/.test(t) ||
    /\b(reservar cita|solicitar cita rapida|quiero cita|quiero reservar|necesito cita|me gustaria pedir cita|quiero agendar cita|quiero pedir cita)\b/.test(t) ||
    /^quiero(\s+una)?\s+(limpieza|revision)(\s+dental)?$/.test(t)
  );
}

export function parseBookingPathSelection(
  text: string,
): 'quick_path_direct' | 'quick_path_reception' | null {
  const t = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  if (/^(1|1\.|1\))$/.test(t)) return 'quick_path_direct';
  if (/^(2|2\.|2\))$/.test(t)) return 'quick_path_reception';
  return null;
}

export function parseStrictOneTwoChoice(text: string): 1 | 2 | null {
  const t = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  if (/^(1|1\.|1\))$/.test(t)) return 1;
  if (/^(2|2\.|2\))$/.test(t)) return 2;
  return null;
}

export function getNextPromptForIntentFromState(
  state: ConversationState,
  intent: string | null | undefined,
) {
  if (intent !== 'appointment_request' && intent !== 'appointment_reschedule') {
    return null;
  }
  return getNextFieldPrompt(
    intent,
    {
      patient: state.patient,
      appointment: state.appointment,
      symptoms: state.symptoms,
    },
    fieldQueryOptionsFromState(state),
  );
}

export function resetAppointmentDraft(state: ConversationState): void {
  state.appointment = {
    service_type: null,
    preferred_date: null,
    preferred_time: null,
    preferred_provider: null,
    flexibility: null,
  };
  state.completed = false;
  state.offer_appointment_pending = false;
  state.appointment_request_open = false;
}

/**
 * Classify the patient's reply when they are selecting which appointment to
 * reschedule from a numbered list.
 */
export function classifyTargetSelection(
  text: string,
  maxOptions: number,
): number | 'abort' | 'ambiguous' {
  const t = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

  const ABORT = /\b(cancelar|cancel|dejalo|dejarlo|nada|ninguna|no quiero|olvidalo|mejor no|dejar)\b/;
  if (ABORT.test(t)) return 'abort';

  const numMatch = t.match(/\b(\d+)\b/);
  if (numMatch) {
    const n = parseInt(numMatch[1], 10);
    return n >= 1 && n <= maxOptions ? n : 'ambiguous';
  }

  const ORDINAL_MAP: Record<string, number> = {
    primera: 1, primero: 1, uno: 1, una: 1,
    segunda: 2, segundo: 2, dos: 2,
    tercera: 3, tercero: 3, tres: 3,
    cuarta: 4, cuarto: 4, cuatro: 4,
  };
  for (const [word, num] of Object.entries(ORDINAL_MAP)) {
    if (t.includes(word) && num <= maxOptions) return num;
  }

  return 'ambiguous';
}

/** Convert DB message history to LLM ChatMessage format. */
export function buildLLMMessages(history: Message[]): ChatMessage[] {
  return history.map((msg) => ({
    role: msg.role === 'patient' ? ('user' as const) : ('assistant' as const),
    content: msg.content,
  }));
}

export function resolveAppointmentWindowFromDraft(
  appointment: Partial<AppointmentDetails>,
): { datetime_start: string; datetime_end: string } | null {
  if (!appointment.preferred_date || !appointment.preferred_time) return null;
  const date = appointment.preferred_date.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const normalized = appointment.preferred_time.toLowerCase().trim();
  const daypartMap: Record<string, string> = {
    morning: '10:00',
    afternoon: '16:00',
    evening: '18:00',
  };

  let hhmm = daypartMap[normalized] ?? null;
  if (!hhmm) {
    const match = normalized.match(/\b(\d{1,2})(?::(\d{2}))?\b/);
    if (!match) return null;
    const hh = Number(match[1]);
    const mm = Number(match[2] ?? '0');
    if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
      return null;
    }
    hhmm = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  const start = new Date(`${date}T${hhmm}:00.000Z`);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return {
    datetime_start: start.toISOString(),
    datetime_end: end.toISOString(),
  };
}

export type ExistingAppointmentWindow = {
  datetime_start: string;
  datetime_end: string;
};

export type NextAvailableSlotsInput = {
  desired_type: 'asap' | 'date';
  date?: string;
  existing_appointments: ExistingAppointmentWindow[];
};

export type NextAvailableSlot = {
  id: string;
  datetime: string;
  label: string;
};

const SLOT_MINUTES = 30;
const MIN_LEAD_TIME_MS = 2 * 60 * 60 * 1000;
const MAX_BOOKING_WINDOW_DAYS = 30;

function overlaps(startA: Date, endA: Date, startB: Date, endB: Date): boolean {
  return startA < endB && endA > startB;
}

function buildBusinessWindowsForDay(day: Date): Array<{ startHour: number; endHour: number }> {
  const weekday = day.getUTCDay();
  if (weekday >= 1 && weekday <= 5) {
    return [
      { startHour: 9, endHour: 14 },
      { startHour: 16, endHour: 20 },
    ];
  }
  if (weekday === 6) {
    return [{ startHour: 9, endHour: 14 }];
  }
  return [];
}

function parseDateOnlyAsUtc(date: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function getNextAvailableSlots(input: NextAvailableSlotsInput): NextAvailableSlot[] {
  const now = new Date();
  const minStart = new Date(now.getTime() + MIN_LEAD_TIME_MS);
  const maxDate = new Date(now.getTime() + MAX_BOOKING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const out: NextAvailableSlot[] = [];

  const existing = input.existing_appointments
    .map((x) => ({
      start: new Date(x.datetime_start),
      end: new Date(x.datetime_end),
    }))
    .filter((x) => !Number.isNaN(x.start.getTime()) && !Number.isNaN(x.end.getTime()) && x.end > x.start);

  const firstDay =
    input.desired_type === 'date' && input.date
      ? parseDateOnlyAsUtc(input.date)
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (!firstDay) return [];

  const lastDay = input.desired_type === 'date' ? firstDay : maxDate;
  for (
    let day = new Date(Date.UTC(firstDay.getUTCFullYear(), firstDay.getUTCMonth(), firstDay.getUTCDate()));
    day <= lastDay && out.length < 3;
    day = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1))
  ) {
    if (day > maxDate) break;
    const windows = buildBusinessWindowsForDay(day);
    for (const w of windows) {
      for (let hour = w.startHour; hour < w.endHour; hour++) {
        for (const minute of [0, 30]) {
          const slotStart = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute, 0, 0));
          const slotEnd = new Date(slotStart.getTime() + SLOT_MINUTES * 60 * 1000);
          if (slotEnd > maxDate) continue;
          if (slotStart < minStart) continue;

          const hasConflict = existing.some((appt) => overlaps(slotStart, slotEnd, appt.start, appt.end));
          if (hasConflict) continue;

          out.push({
            id: `slot_${slotStart.toISOString()}`,
            datetime: slotStart.toISOString(),
            label: slotStart.toLocaleString('es-ES', {
              weekday: 'short',
              day: '2-digit',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
              timeZone: 'UTC',
            }),
          });
          if (out.length === 3) return out;
        }
      }
    }
    if (input.desired_type === 'date') break;
  }

  return out;
}
