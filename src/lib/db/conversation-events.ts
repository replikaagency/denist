import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { log } from '@/lib/logger';

/** Known event_type values (DB column is text for forward compatibility). */
export const CONVERSATION_EVENT_TYPES = [
  'booking_link_shown',
  'hybrid_booking_created',
  'appointment_request_created',
  'handoff_created',
  'hybrid_status_changed',
  'appointment_status_changed',
] as const;

export type ConversationEventType = (typeof CONVERSATION_EVENT_TYPES)[number];

/**
 * Append a single lifecycle row. Never throws — failures are logged only
 * so analytics cannot break chat or staff flows.
 */
export function appendConversationEvent(params: {
  conversationId: string;
  contactId: string;
  leadId?: string | null;
  eventType: ConversationEventType;
  source?: string | null;
  metadata?: Record<string, unknown>;
}): void {
  void (async () => {
    try {
      const rowMetadata = {
        ...(params.metadata ?? {}),
        conversation_id: params.conversationId,
        contact_id: params.contactId,
        lead_id: params.leadId ?? null,
      };

      const { error } = await createSupabaseAdminClient()
        .from('conversation_events')
        .insert({
          conversation_id: params.conversationId,
          contact_id: params.contactId,
          lead_id: params.leadId ?? null,
          event_type: params.eventType,
          source: params.source ?? null,
          metadata: rowMetadata,
        });

      if (error) {
        log('error', 'conversation_event.insert_failed', {
          event_type: params.eventType,
          conversation_id: params.conversationId,
          message: error.message,
        });
      }
    } catch (err) {
      log('error', 'conversation_event.insert_exception', {
        event_type: params.eventType,
        conversation_id: params.conversationId,
        error: err instanceof Error ? err.message : err,
      });
    }
  })();
}
