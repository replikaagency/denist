import type { NormalizedInboundPatientMessage } from '@/lib/channels/types';

/** Twilio POST field names (application/x-www-form-urlencoded). */
export const TWILIO_FORM = {
  MESSAGE_SID: 'MessageSid',
  FROM: 'From',
  BODY: 'Body',
  TO: 'To',
  NUM_MEDIA: 'NumMedia',
} as const;

/**
 * Parse Twilio WhatsApp webhook form fields into the channel-normalized shape.
 *
 * TODO (activation): call from the webhook route after:
 * - validating X-Twilio-Signature with TWILIO_AUTH_TOKEN (or dedicated signing secret if you use one)
 * - confirming the request is whatsapp:* (From prefix)
 * - rate limiting per From
 *
 * STUB: not invoked by the production route yet — exported for unit tests / future wiring.
 */
export function normalizeTwilioWhatsAppInbound(form: URLSearchParams): NormalizedInboundPatientMessage | null {
  const body = form.get(TWILIO_FORM.BODY)?.trim() ?? '';
  const from = form.get(TWILIO_FORM.FROM)?.trim() ?? '';
  const sid = form.get(TWILIO_FORM.MESSAGE_SID)?.trim() ?? null;

  if (!from || !body) return null;

  // TODO: strip whatsapp: prefix and normalize via lib/phone before DB lookup
  const fromPhone = from.replace(/^whatsapp:/i, '');

  return {
    channel: 'whatsapp',
    fromPhone,
    body,
    externalMessageId: sid,
    provider: 'twilio_whatsapp',
  };
}
