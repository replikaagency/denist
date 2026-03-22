import type { ConversationState, HybridBookingSignal } from '@/lib/conversation/schema';
import { detectAvailabilityStyleMessage } from '@/lib/conversation/hybrid-booking-detection';
import {
  createHybridBooking,
  getActiveHybridBookingForConversation,
  updateHybridBooking,
} from '@/lib/db/hybrid-bookings';
import { appendConversationEvent } from '@/lib/db/conversation-events';
import type { HybridBookingMode } from '@/types/database';

/** @deprecated Prefer formatAvailabilityCapturedEs + merge helpers. */
export const HYBRID_AVAILABILITY_ACK_ES =
  'He anotado tu disponibilidad. Nuestro equipo te contactará cuando haya un hueco que encaje contigo.';

export interface HybridAvailabilityPayload {
  service_interest: string | null;
  preferred_days: string[];
  preferred_time_ranges: string[];
  availability_notes: string | null;
  wants_callback: boolean;
  booking_mode: HybridBookingMode;
}

/** Offer: direct link vs manual request (exact product copy). */
export function hybridOfferTwoWaysBlockEs(url: string): string {
  const u = url.trim();
  return (
    'Puedes hacerlo de dos formas:\n\n' +
    '1. Reservar directamente aquí:\n' +
    `👉 ${u}\n\n` +
    '2. O si prefieres, puedo registrar tu solicitud y el equipo te contacta.'
  );
}

/** After patient chooses the direct booking path (link will follow or is shown). */
export function thankDirectBookingChoiceEs(): string {
  return (
    'Genial. Al reservar en el enlace eliges tú el hueco según lo que veas disponible; ' +
    'eso sí es una reserva directa en ese sistema. Si más adelante prefieres que te ayudemos por aquí, dímelo.'
  );
}

/** Brief read-back after structured availability / callback preference is stored. */
export function formatAvailabilityCapturedEs(payload: HybridAvailabilityPayload): string {
  const bits: string[] = [];
  if (payload.preferred_days.length) bits.push(`días: ${payload.preferred_days.join(', ')}`);
  if (payload.preferred_time_ranges.length) bits.push(`horarios: ${payload.preferred_time_ranges.join('; ')}`);
  if (payload.service_interest) bits.push(`motivo: ${payload.service_interest}`);
  const recap = bits.length ? ` Te lo dejo anotado así (${bits.join(' · ')}).` : '';
  return (
    `Perfecto.${recap} Esto no es una cita confirmada todavía: cuando haya opciones, el equipo te contactará. ` +
    'Si quieres añadir alguna nota más, dímelo.'
  );
}

const MAX_NOTE_LEN = 2000;

/** Build DB payload from LLM signal + merged appointment state + patient message (testable). */
export function buildHybridAvailabilityPayload(
  hb: HybridBookingSignal | null | undefined,
  state: Pick<ConversationState, 'appointment'>,
  patientMessage: string,
): HybridAvailabilityPayload {
  const service_interest =
    hb?.service_interest?.trim() || state.appointment.service_type?.trim() || null;

  const preferred_days = hb?.preferred_days?.length
    ? [...hb.preferred_days]
    : [];

  const ranges: string[] = hb?.preferred_time_ranges?.length
    ? [...hb.preferred_time_ranges]
    : [];
  if (ranges.length === 0 && state.appointment.preferred_time?.trim()) {
    ranges.push(state.appointment.preferred_time.trim());
  }

  let availability_notes = hb?.availability_notes?.trim() || null;
  if (!availability_notes && patientMessage.trim()) {
    availability_notes = patientMessage.trim().slice(0, MAX_NOTE_LEN);
  }

  const mode: HybridBookingMode =
    hb?.booking_mode === 'callback_request' ? 'callback_request' : 'availability_capture';

  return {
    service_interest,
    preferred_days,
    preferred_time_ranges: ranges,
    availability_notes,
    wants_callback: hb?.wants_callback !== false,
    booking_mode: mode,
  };
}

export interface HybridBookingTurnContext {
  conversationId: string;
  contactId: string;
  leadId: string;
  patientMessage: string;
  state: ConversationState;
  hybridSignal: HybridBookingSignal | null | undefined;
  bookingSelfServiceUrl: string;
}

export interface HybridBookingTurnResult {
  /** When true, skip standard appointment confirmation / createRequest for this turn (new booking only). */
  deferredStandardFlow: boolean;
  /** Set when structured availability or callback path was persisted this turn. */
  capturePayload?: HybridAvailabilityPayload;
}

/**
 * Persist hybrid booking side effects for new appointment_request flows only.
 * Does not replace appointment_requests — runs alongside when patient picks link or flexible availability.
 */
export async function processHybridBookingTurn(
  ctx: HybridBookingTurnContext,
): Promise<HybridBookingTurnResult> {
  const hb = ctx.hybridSignal;
  const url = ctx.bookingSelfServiceUrl.trim();

  const declinedLink = hb?.patient_declined_direct_link === true;
  const choseLink =
    !declinedLink &&
    (hb?.patient_chose_direct_link === true ||
      hb?.booking_mode === 'direct_link');

  const availabilityFromLlm =
    hb?.booking_mode === 'availability_capture' || hb?.booking_mode === 'callback_request';

  const availabilityFromText =
    !choseLink && detectAvailabilityStyleMessage(ctx.patientMessage);

  const shouldCaptureAvailability =
    !choseLink &&
    (availabilityFromLlm || availabilityFromText) &&
    !declinedLink;

  let deferredStandardFlow = false;
  let capturePayload: HybridAvailabilityPayload | undefined;

  if (shouldCaptureAvailability) {
    const payload = buildHybridAvailabilityPayload(hb, ctx.state, ctx.patientMessage);
    capturePayload = payload;
    const existing = await getActiveHybridBookingForConversation(ctx.conversationId);
    if (existing) {
      await updateHybridBooking(existing.id, {
        ...payload,
        lead_id: ctx.leadId,
        metadata: {
          ...(existing.metadata ?? {}),
          last_patient_message_excerpt: ctx.patientMessage.slice(0, 500),
        },
      });
    } else {
      const created = await createHybridBooking({
        contact_id: ctx.contactId,
        conversation_id: ctx.conversationId,
        lead_id: ctx.leadId,
        ...payload,
        metadata: { source: 'chat_availability_capture' },
      });
      appendConversationEvent({
        conversationId: ctx.conversationId,
        contactId: ctx.contactId,
        leadId: ctx.leadId,
        eventType: 'hybrid_booking_created',
        source: 'chat',
        metadata: {
          hybrid_booking_id: created.id,
          booking_mode: created.booking_mode,
          path: 'chat_availability_capture',
        },
      });
    }
    deferredStandardFlow = true;
  } else if (url && choseLink) {
    const existing = await getActiveHybridBookingForConversation(ctx.conversationId);
    if (existing) {
      await updateHybridBooking(existing.id, {
        booking_mode: 'direct_link',
        wants_callback: false,
        lead_id: ctx.leadId,
        metadata: {
          ...(existing.metadata ?? {}),
          link_sent_at: new Date().toISOString(),
          booking_url: url,
        },
      });
    } else {
      const created = await createHybridBooking({
        contact_id: ctx.contactId,
        conversation_id: ctx.conversationId,
        lead_id: ctx.leadId,
        booking_mode: 'direct_link',
        wants_callback: false,
        service_interest: ctx.state.appointment.service_type,
        metadata: { source: 'chat_direct_link', link_sent_at: new Date().toISOString(), booking_url: url },
      });
      appendConversationEvent({
        conversationId: ctx.conversationId,
        contactId: ctx.contactId,
        leadId: ctx.leadId,
        eventType: 'hybrid_booking_created',
        source: 'chat',
        metadata: {
          hybrid_booking_id: created.id,
          booking_mode: created.booking_mode,
          path: 'chat_direct_link',
        },
      });
    }
    deferredStandardFlow = true;
  }

  return { deferredStandardFlow, capturePayload };
}

/** Append the two-way offer block if not already present (LLM may have paraphrased). */
export function mergeHybridOfferTwoWaysReply(reply: string, url: string): string {
  const u = url.trim();
  if (!u) return reply;
  const r = reply.trim();
  if (r.includes(u) && r.toLowerCase().includes('dos formas')) return reply;
  if (r.includes('👉') && r.includes(u)) return reply;
  return `${r}\n\n${hybridOfferTwoWaysBlockEs(u)}`;
}

/** Thank-you + ensure link visible after patient chose direct booking path. */
export function mergeDirectBookingChoiceReply(reply: string, url: string): string {
  const u = url.trim();
  let r = reply.trim();
  if (!r.includes('Al reservar en el enlace')) {
    r = `${r}\n\n${thankDirectBookingChoiceEs()}`;
  }
  if (u && !r.includes(u)) {
    r = `${r}\n\n👉 ${u}`;
  }
  return r;
}

/** Deterministic recap after availability capture (avoids vague LLM closure). */
export function mergeAvailabilityCaptureReply(reply: string, payload: HybridAvailabilityPayload): string {
  const r = reply.trim();
  const block = formatAvailabilityCapturedEs(payload);
  if (r.includes('no es una cita confirmada') || r.includes('No es una cita confirmada')) return reply;
  return `${r}\n\n${block}`;
}

export function appendDirectLinkToReply(reply: string, url: string): string {
  if (!url.trim() || reply.includes(url.trim())) return reply;
  return `${reply}\n\nSi prefieres elegir tú el horario, aquí tienes el enlace de reserva: ${url.trim()}`;
}

export function appendHybridAckToReply(reply: string): string {
  if (reply.includes('disponibilidad') || reply.includes('cita confirmada')) return reply;
  return `${reply}\n\n${HYBRID_AVAILABILITY_ACK_ES}`;
}
