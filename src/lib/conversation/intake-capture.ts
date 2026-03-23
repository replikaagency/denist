import { saveState } from '@/services/conversation.service';
import { insertMessage } from '@/lib/db/messages';
import { looksLikeFullName, extractNameGuard, looksLikePhone, extractPhoneGuard, looksLikeEmail, extractEmailGuard, isYes, isNo, extractNewOrReturningGuard } from './intake-guards';
import { getMissingFields } from './fields';
import type { ConversationState } from './schema';
import type { Contact, Conversation } from '@/types/database';

type IntakeCaptureParams = {
  state: ConversationState;
  content: string;
  conversation_id: string;
  contact: Contact;
  getConversationById: (conversationId: string) => Promise<Conversation>;
};

type IntakeCaptureResult = {
  message: Awaited<ReturnType<typeof insertMessage>>;
  contact: Contact;
  conversation: Conversation;
  turnResult: null;
};

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
}: IntakeCaptureParams): Promise<IntakeCaptureResult | null> {
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
      content: `¡Perfecto! ¿Tienes un correo electrónico donde mandarte la confirmación?`,
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
  if (field === 'patient.new_or_returning') {
    const newOrReturning = extractNewOrReturningGuard(content);
    if (newOrReturning) {
      state.patient.new_or_returning = newOrReturning;
      await saveState(conversation_id, state);
      const aiMessage = await insertMessage({
        conversation_id,
        role: 'ai',
        content: newOrReturning === 'new' ? `¡Bienvenido/a! ¿Me dices tu nombre completo?` : `¡Genial! ¿Me dices tu nombre completo?`,
        metadata: { type: 'intake_guard', field: 'new_or_returning' },
      });
      return { message: aiMessage, contact, conversation: await getConversationById(conversation_id), turnResult: null };
    }
    if (isYes(content)) {
      state.patient.new_or_returning = 'new';
      await saveState(conversation_id, state);
      const aiMessage = await insertMessage({
        conversation_id,
        role: 'ai',
        content: `¡Bienvenido/a! ¿Me dices tu nombre completo?`,
        metadata: { type: 'intake_guard', field: 'new_or_returning' },
      });
      return { message: aiMessage, contact, conversation: await getConversationById(conversation_id), turnResult: null };
    }
    if (isNo(content)) {
      state.patient.new_or_returning = 'returning';
      await saveState(conversation_id, state);
      const aiMessage = await insertMessage({
        conversation_id,
        role: 'ai',
        content: `¡Genial! ¿Me dices tu nombre completo?`,
        metadata: { type: 'intake_guard', field: 'new_or_returning' },
      });
      return { message: aiMessage, contact, conversation: await getConversationById(conversation_id), turnResult: null };
    }
  }
  return null;
}
