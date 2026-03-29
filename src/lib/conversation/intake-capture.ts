import { saveState } from '@/services/conversation.service';
import { insertMessage } from '@/lib/db/messages';
import { looksLikeFullName, extractNameGuard, looksLikePhone, extractPhoneGuard, looksLikeEmail, extractEmailGuard } from './intake-guards';
import { getMissingFields } from './fields';
import type { ConversationState } from '@/lib/conversation/schema';
import type { Contact } from '@/types/database';

/**
 * Attempts to deterministically capture a required intake field from user input.
 * Returns an object with { message, contact, conversation, turnResult } if captured, else null.
 */
export async function tryDeterministicIntakeCapture({
  state,
  content,
  conversation_id,
  contact,
  getConversationById,
}: {
  state: ConversationState;
  content: string;
  conversation_id: string;
  contact: Contact;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getConversationById: (id: string) => Promise<any>;
  priorPatientTexts?: string[];
}) {
  const missingFields = state.current_intent ? getMissingFields(state.current_intent, { patient: state.patient, appointment: state.appointment, symptoms: state.symptoms }) : [];
  if (missingFields.length === 0) return null;
  const field = missingFields[0];
  if (field === 'patient.full_name' && looksLikeFullName(content)) {
    const name = extractNameGuard(content);
    state.patient.full_name = name;
    await saveState(conversation_id, state);
    const aiMessage = await insertMessage({
      conversation_id,
      role: 'ai',
      content: `¡Gracias, ${name?.split(' ')[0] || 'paciente'}! ¿A qué número te podemos llamar?`,
      metadata: { type: 'intake_guard', field: 'full_name' },
    });
    return { message: aiMessage, contact, conversation: await getConversationById(conversation_id), turnResult: null };
  }
  if (field === 'patient.phone' && looksLikePhone(content)) {
    const phone = extractPhoneGuard(content);
    state.patient.phone = phone;
    await saveState(conversation_id, state);
    const aiMessage = await insertMessage({
      conversation_id,
      role: 'ai',
      content: `¡Perfecto! ¿Tienes un correo electrónico donde mandarte el resumen?`,
      metadata: { type: 'intake_guard', field: 'phone' },
    });
    return { message: aiMessage, contact, conversation: await getConversationById(conversation_id), turnResult: null };
  }
  if (field === 'patient.email' && looksLikeEmail(content)) {
    const email = extractEmailGuard(content);
    state.patient.email = email;
    await saveState(conversation_id, state);
    const aiMessage = await insertMessage({
      conversation_id,
      role: 'ai',
      content: `¡Gracias! ¿Es tu primera vez en la clínica o ya eres paciente nuestro/a?`,
      metadata: { type: 'intake_guard', field: 'email' },
    });
    return { message: aiMessage, contact, conversation: await getConversationById(conversation_id), turnResult: null };
  }
  return null;
}
