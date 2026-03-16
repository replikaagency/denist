import { createHandoffEvent } from '@/lib/db/handoffs';
import { updateConversation } from '@/lib/db/conversations';
import type { HandoffEvent, HandoffReason } from '@/types/database';
import type { EscalationDecision } from '@/lib/conversation/engine';

const ESCALATION_TYPE_TO_REASON: Record<string, HandoffReason> = {
  emergency: 'emergency',
  human: 'ai_escalation',
};

/**
 * Create a handoff event from an engine escalation decision.
 * Transitions conversation to `waiting_human` and disables AI.
 */
export async function createHandoff(input: {
  conversationId: string;
  contactId: string;
  escalation: EscalationDecision;
  triggerMessageId?: string;
}): Promise<HandoffEvent> {
  const reason: HandoffReason =
    ESCALATION_TYPE_TO_REASON[input.escalation.type ?? ''] ?? 'ai_escalation';

  const handoff = await createHandoffEvent({
    conversation_id: input.conversationId,
    contact_id: input.contactId,
    reason,
    trigger_message_id: input.triggerMessageId,
    notes: input.escalation.reason ?? undefined,
  });

  await updateConversation(input.conversationId, {
    status: 'waiting_human',
    ai_enabled: false,
  });

  return handoff;
}
