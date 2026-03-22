import { log } from '@/lib/logger';
import { twilioWhatsAppOutboundReady } from '@/lib/twilio/config';

export interface TwilioWhatsAppOutboundPayload {
  toPhoneE164: string;
  body: string;
}

/**
 * Outbound WhatsApp via Twilio — STUB ONLY.
 *
 * TODO (activation): implement with twilio SDK or fetch Messages API:
 * - From: TWILIO_WHATSAPP_FROM (e.g. whatsapp:+14155238886)
 * - To: whatsapp:+<patient>
 * - respect 24h session vs Content API / templates outside window
 *
 * Never throws; logs and returns false when not ready or still stubbed.
 */
export async function sendTwilioWhatsAppMessage(_payload: TwilioWhatsAppOutboundPayload): Promise<boolean> {
  if (!twilioWhatsAppOutboundReady()) {
    log('warn', 'twilio.whatsapp.outbound_skipped', { reason: 'missing_env' });
    return false;
  }

  log('info', 'twilio.whatsapp.outbound_stub', {
    note: 'Implement HTTP client + template/session rules before sending',
  });
  return false;
}
