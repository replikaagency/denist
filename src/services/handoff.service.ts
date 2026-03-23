import { createHandoffEvent, getOpenHandoffForConversation } from '@/lib/db/handoffs';
import { appendConversationEvent } from '@/lib/db/conversation-events';
import { getConversationById, updateConversation } from '@/lib/db/conversations';
import { getContactById } from '@/lib/db/contacts';
import { sendEscalationEmail } from '@/lib/notifications/escalation-email';
import type { HandoffEvent, HandoffReason } from '@/types/database';
import type { EscalationDecision } from '@/lib/conversation/engine';

const ESCALATION_TYPE_TO_REASON: Record<string, HandoffReason> = {
  emergency: 'emergency',
  human: 'ai_escalation',
};

/**
 * Create a handoff event from an engine escalation decision.
 * Transitions conversation to `waiting_human` and disables AI.
 *
 * Idempotent: if an open handoff already exists for this conversation,
 * returns the existing record and ensures status/ai_enabled are in sync.
 * This guards against concurrent requests and LLM retries both triggering
 * the same escalation.
 */
export async function createHandoff(input: {
  conversationId: string;
  contactId: string;
  escalation: EscalationDecision;
  triggerMessageId?: string;
}): Promise<HandoffEvent> {
  const existing = await getOpenHandoffForConversation(input.conversationId);

  if (existing) {
    // Ensure conversation state is consistent even if a previous attempt
    // only partially completed (e.g. created the event but crashed before
    // the status update).
    await updateConversation(input.conversationId, {
      status: 'waiting_human',
      ai_enabled: false,
    });
    return existing;
  }

  const reason: HandoffReason =
    ESCALATION_TYPE_TO_REASON[input.escalation.type ?? ''] ?? 'ai_escalation';

  const handoff = await createHandoffEvent({
    conversation_id: input.conversationId,
    contact_id: input.contactId,
    reason,
    trigger_message_id: input.triggerMessageId,
    notes: input.escalation.reason ?? undefined,
  });

  const conv = await getConversationById(input.conversationId);
  appendConversationEvent({
    conversationId: input.conversationId,
    contactId: input.contactId,
    leadId: conv.lead_id ?? null,
    eventType: 'handoff_created',
    source: 'chat',
    metadata: {
      handoff_event_id: handoff.id,
      handoff_reason: handoff.reason,
      escalation_type: input.escalation.type ?? null,
      trigger_message_id: input.triggerMessageId ?? null,
    },
  });

  await updateConversation(input.conversationId, {
    status: 'waiting_human',
    ai_enabled: false,
  });

  // Non-critical: email failure must never block the handoff.
  try {
    const contact = await getContactById(handoff.contact_id);
    await sendEscalationEmail({
      conversationId: input.conversationId,
      patientName: contact.first_name ?? null,
      patientPhone: contact.phone ?? null,
      reason: input.escalation.reason ?? null,
      escalationType: input.escalation.type ?? null,
    });
  } catch (err) {
    console.error('[Notifications] escalation_email_failed', {
      conversationId: input.conversationId,
      error: err instanceof Error ? err.message : err,
    });
  }

  return handoff;
}
