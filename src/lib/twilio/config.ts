/**
 * Twilio WhatsApp — configuration helpers (no network calls).
 * Missing vars are OK: the app must not require these at startup (see lib/env.ts).
 */

export function twilioCoreEnvPresent(): boolean {
  return !!(
    process.env.TWILIO_ACCOUNT_SID?.trim()
    && process.env.TWILIO_AUTH_TOKEN?.trim()
  );
}

export function twilioWhatsAppFromPresent(): boolean {
  return !!process.env.TWILIO_WHATSAPP_FROM?.trim();
}

/**
 * True when all vars commonly needed for outbound WhatsApp are non-empty.
 * Inbound signature validation typically uses TWILIO_AUTH_TOKEN (see Twilio docs).
 */
export function twilioWhatsAppOutboundReady(): boolean {
  return twilioCoreEnvPresent() && twilioWhatsAppFromPresent();
}

/**
 * Opt-in gate for turning on real webhook processing (not implemented in stub phase).
 * Until this is 'true', POST /api/webhooks/twilio/whatsapp never calls processChatMessage.
 */
export function twilioWhatsAppInboundProcessingEnabled(): boolean {
  return process.env.TWILIO_WHATSAPP_INBOUND_ENABLED === 'true';
}
