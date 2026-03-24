import type { ConversationState, HybridBookingSignal } from '@/lib/conversation/schema';
import {
  detectAvailabilityStyleMessage,
  extractHybridAvailabilityHintsFromText,
  type HybridTextHints,
} from '@/lib/conversation/hybrid-booking-detection';
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
    'Puedes reservar de dos formas:\n\n' +
    '1. Reservar directamente aquí:\n' +
    `👉 ${u}\n\n` +
    '2. O, si prefieres, registro tu solicitud y el equipo te contacta.'
  );
}

/** After patient chooses the direct booking path (link will follow or is shown). */
export function thankDirectBookingChoiceEs(): string {
  return (
    'Perfecto. En ese enlace eliges tú el hueco disponible y la reserva se hace allí directamente. ' +
    'Si luego prefieres gestionarlo por aquí, te ayudo.'
  );
}

/** Natural-language recap line (avoids sounding like a fixed appointment). */
function buildAvailabilityRecapSentence(payload: HybridAvailabilityPayload): string {
  const { service_interest, preferred_days, preferred_time_ranges } = payload;
  if (
    !service_interest &&
    preferred_days.length === 0 &&
    preferred_time_ranges.length === 0
  ) {
    return '';
  }
  const parts: string[] = ['He anotado que'];
  if (service_interest) {
    parts.push(`prefieres ${service_interest}`);
  }
  if (preferred_days.length) {
    parts.push(`los ${preferred_days.join(', ')}`);
  }
  if (preferred_time_ranges.length) {
    parts.push(preferred_time_ranges.join('; '));
  }
  return `${parts[0]} ${parts.slice(1).join(' ')}.`;
}

/**
 * Removes a first sentence that sounds like a confirmed booking (LLM slip), keeps follow-up questions.
 * Exported for tests.
 */
export function stripHybridCommittalLeadIn(reply: string): string {
  const t = reply.trim();
  if (!t) return '';
  const split = t.split(/(?<=[.!?])\s+/);
  const first = split[0] ?? '';
  if (
    first &&
    /(te apunto|te reservo|te confirmo|te cito\s+para|te dejo\s+(?:la\s+)?cita|reserva\s+confirmada)/i.test(
      first,
    )
  ) {
    return split.slice(1).join(' ').trim();
  }
  return t;
}

/** Brief read-back after structured availability / callback preference is stored. */
export function formatAvailabilityCapturedEs(payload: HybridAvailabilityPayload): string {
  const recap = buildAvailabilityRecapSentence(payload);
  const opening = recap
    ? recap
    : 'He anotado tu preferencia para la solicitud de cita.';
  return (
    `${opening}\n\n` +
    'Esto es una solicitud, no una cita confirmada. Cuando haya opciones, el equipo te contactará. ' +
    'Ahora te pido unos datos para registrarla. ' +
    'Si quieres añadir alguna nota más, dímelo.'
  );
}

const MAX_NOTE_LEN = 2000;

/** Build DB payload from LLM signal + merged appointment state + patient message (testable). */
export function buildHybridAvailabilityPayload(
  hb: HybridBookingSignal | null | undefined,
  state: Pick<ConversationState, 'appointment'>,
  patientMessage: string,
  /** When the caller already computed hints (avoids duplicate extraction in one turn). */
  hintsOverride?: HybridTextHints,
): HybridAvailabilityPayload {
  const hints = hintsOverride ?? extractHybridAvailabilityHintsFromText(patientMessage);

  const service_interest =
    hb?.service_interest?.trim() ||
    state.appointment.service_type?.trim() ||
    hints.service_interest ||
    null;

  const preferred_days = hb?.preferred_days?.length
    ? [...hb.preferred_days]
    : hints.preferred_days.length
      ? [...hints.preferred_days]
      : [];

  const ranges: string[] = hb?.preferred_time_ranges?.length
    ? [...hb.preferred_time_ranges]
    : [];
  if (ranges.length === 0 && state.appointment.preferred_time?.trim()) {
    ranges.push(state.appointment.preferred_time.trim());
  }
  if (ranges.length === 0 && hints.preferred_time_ranges.length) {
    ranges.push(...hints.preferred_time_ranges);
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

  const textHints = extractHybridAvailabilityHintsFromText(ctx.patientMessage);

  const availabilityFromText =
    !choseLink && detectAvailabilityStyleMessage(ctx.patientMessage);

  /** When regex-based detection misses but we still extracted time-of-day / clock constraints. */
  const availabilityFromStructuredHints =
    !choseLink && textHints.preferred_time_ranges.length > 0;

  const shouldCaptureAvailability =
    !choseLink &&
    (availabilityFromLlm || availabilityFromText || availabilityFromStructuredHints) &&
    !declinedLink;

  let deferredStandardFlow = false;
  let capturePayload: HybridAvailabilityPayload | undefined;

  if (shouldCaptureAvailability) {
    const payload = buildHybridAvailabilityPayload(hb, ctx.state, ctx.patientMessage, textHints);
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
  if (
    /no\s+es\s+una\s+cita\s+confirmada/i.test(r) ||
    /solicitud,\s+no\s+una\s+cita\s+confirmada/i.test(r)
  ) {
    return reply;
  }
  const stripped = stripHybridCommittalLeadIn(r);
  if (!stripped) return block;
  return `${block}\n\n${stripped}`;
}

export function appendDirectLinkToReply(reply: string, url: string): string {
  if (!url.trim() || reply.includes(url.trim())) return reply;
  return `${reply}\n\nSi prefieres elegir tú el horario, aquí tienes el enlace: ${url.trim()}`;
}

export function appendHybridAckToReply(reply: string): string {
  if (reply.includes('disponibilidad') || reply.includes('cita confirmada')) return reply;
  return `${reply}\n\n${HYBRID_AVAILABILITY_ACK_ES}`;
}
