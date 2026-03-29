/**
 * Intake-related I/O helpers and inbound message token routing (no LLM).
 */

import { getRecentMessages } from '@/lib/db/messages';
import type { ConversationState } from '@/lib/conversation/schema';

export async function getPriorPatientMessageTexts(conversationId: string): Promise<string[]> {
  const recent = await getRecentMessages(conversationId, 24);
  return recent.filter((m) => m.role === 'patient').map((m) => m.content);
}

export function clearReceptionPhoneStrictGateIfPhoneSatisfied(state: ConversationState): void {
  const m = state.metadata as Record<string, unknown>;
  if (state.patient.phone) {
    delete m.reception_phone_strict_gate;
  }
}

/** Map structured UI tokens to natural phrases before routing / LLM. */
export function mapGuidedChoiceToken(text: string): string {
  if (text === 'service_cleaning') return 'quiero una limpieza';
  if (text === 'service_checkup') return 'quiero una revision';
  if (text === 'service_ortho') return 'quiero ortodoncia';
  if (text === 'date_today') return 'hoy';
  if (text === 'date_tomorrow') return 'mañana';
  if (text === 'date_this_week') return 'esta semana';
  return text;
}
