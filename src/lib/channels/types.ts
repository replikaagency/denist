import type { ConversationChannel } from '@/types/database';

/**
 * Normalized shape for any future inbound patient message (WhatsApp, SMS, etc.).
 * Not wired into processChatMessage yet — used as the adapter contract.
 *
 * Maps to DB: conversations.channel uses ConversationChannel ('whatsapp', 'web_chat', …).
 */
export interface NormalizedInboundPatientMessage {
  channel: ConversationChannel;
  /** E.164 or normalized digits — matches contacts.phone resolution */
  fromPhone: string;
  body: string;
  /** Twilio MessageSid / provider id — idempotency & dedup when live */
  externalMessageId?: string | null;
  /** Optional raw reference for debugging (do not log PHI in production) */
  provider: 'twilio_whatsapp';
}
