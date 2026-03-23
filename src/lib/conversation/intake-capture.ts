import { saveState } from '@/services/conversation.service';
import { insertMessage } from '@/lib/db/messages';
import { looksLikeFullName, extractNameGuard, looksLikePhone, extractPhoneGuard, isYes, isNo, extractNewOrReturningGuard, extractTimePreferenceGuard, extractFastBookingDetails } from './intake-guards';
import { getMissingFields, getNextFieldPrompt } from './fields';
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
  if (state.current_intent === 'appointment_request' || state.current_intent === 'appointment_reschedule') {
    const details = extractFastBookingDetails(content);
    let capturedAny = false;
    const microAcks: string[] = [];
    const isMissing = (f: string) => missingFields.includes(f as never);
    if (details.full_name && isMissing('patient.full_name') && !state.patient.full_name) {
      state.patient.full_name = details.full_name;
      microAcks.push(`Perfecto, ${details.full_name.split(' ')[0]}.`);
      capturedAny = true;
    }
    if (details.phone && isMissing('patient.phone') && !state.patient.phone) {
      state.patient.phone = details.phone;
      microAcks.push('Genial, teléfono anotado.');
      capturedAny = true;
    }
    if (details.new_or_returning && isMissing('patient.new_or_returning') && !state.patient.new_or_returning) {
      state.patient.new_or_returning = details.new_or_returning;
      microAcks.push(details.new_or_returning === 'new' ? 'Genial, es tu primera vez.' : 'Perfecto, ya has venido antes.');
      capturedAny = true;
    }
    if (details.service_type && isMissing('appointment.service_type') && !state.appointment.service_type) {
      state.appointment.service_type = details.service_type;
      microAcks.push(`Perfecto, ${details.service_type}.`);
      capturedAny = true;
    }
    if (details.preferred_date && isMissing('appointment.preferred_date') && !state.appointment.preferred_date) {
      state.appointment.preferred_date = details.preferred_date;
      microAcks.push(`Anotado, ${details.preferred_date}.`);
      capturedAny = true;
    }
    if (details.preferred_time && isMissing('appointment.preferred_time') && !state.appointment.preferred_time) {
      state.appointment.preferred_time = details.preferred_time;
      microAcks.push(`Vale, ${formatTimePreferenceAck(details.preferred_time)}.`);
      capturedAny = true;
    }
    if (capturedAny) {
      await saveState(conversation_id, state);
      const nextPrompt = state.current_intent
        ? getNextFieldPrompt(state.current_intent, {
            patient: state.patient,
            appointment: state.appointment,
            symptoms: state.symptoms,
          })
        : null;
      const aiMessage = await insertMessage({
        conversation_id,
        role: 'ai',
        content: composeAckAndPromptWithOptionalSideAnswer(
          microAcks,
          nextPrompt?.prompt ?? 'Perfecto, lo dejo anotado.',
          content,
        ),
        metadata: { type: 'intake_guard', field: 'booking_shortcut' },
      });
      return { message: aiMessage, contact, conversation: await getConversationById(conversation_id), turnResult: null };
    }
  }
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
      content: '¿Es tu primera vez en nuestra clínica o ya has venido antes?',
      metadata: {
        type: 'patient_status_choice',
        field: 'new_or_returning',
        options: [
          { label: 'Es mi primera vez', value: 'patient_status_new' },
          { label: 'Ya he venido antes', value: 'patient_status_returning' },
        ],
      },
    });
    return { message: aiMessage, contact, conversation: await getConversationById(conversation_id), turnResult: null };
  }
  if (field === 'patient.new_or_returning') {
    const buildNextPrompt = (ack?: string) =>
      composeAckAndPrompt(
        ack ? [ack] : [],
        state.current_intent
          ? getNextFieldPrompt(state.current_intent, {
              patient: state.patient,
              appointment: state.appointment,
              symptoms: state.symptoms,
            })?.prompt ?? 'Perfecto, lo dejo anotado.'
          : 'Perfecto, lo dejo anotado.',
      );
    const newOrReturning = extractNewOrReturningGuard(content);
    if (newOrReturning) {
      state.patient.new_or_returning = newOrReturning;
      await saveState(conversation_id, state);
      const aiMessage = await insertMessage({
        conversation_id,
        role: 'ai',
        content: buildNextPrompt(newOrReturning === 'new' ? 'Genial, es tu primera vez.' : 'Perfecto, ya has venido antes.'),
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
        content: buildNextPrompt('Genial, es tu primera vez.'),
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
        content: buildNextPrompt('Perfecto, ya has venido antes.'),
        metadata: { type: 'intake_guard', field: 'new_or_returning' },
      });
      return { message: aiMessage, contact, conversation: await getConversationById(conversation_id), turnResult: null };
    }
  }
  if (field === 'appointment.preferred_time') {
    const timePreference = extractTimePreferenceGuard(content);
    if (timePreference?.kind === 'ask_exact') {
      const aiMessage = await insertMessage({
        conversation_id,
        role: 'ai',
        content: 'Perfecto. ¿Qué hora concreta te viene mejor?',
        metadata: { type: 'intake_guard', field: 'preferred_time' },
      });
      return { message: aiMessage, contact, conversation: await getConversationById(conversation_id), turnResult: null };
    }
    if (timePreference?.kind === 'value') {
      state.appointment.preferred_time = timePreference.value;
      await saveState(conversation_id, state);
      const nextPrompt = state.current_intent
        ? getNextFieldPrompt(state.current_intent, {
            patient: state.patient,
            appointment: state.appointment,
            symptoms: state.symptoms,
          })
        : null;
      const aiMessage = await insertMessage({
        conversation_id,
        role: 'ai',
        content: composeAckAndPrompt(
          [`Vale, ${formatTimePreferenceAck(timePreference.value)}.`],
          nextPrompt?.prompt ?? 'Perfecto, lo dejo anotado.',
        ),
        metadata: { type: 'intake_guard', field: 'preferred_time' },
      });
      return { message: aiMessage, contact, conversation: await getConversationById(conversation_id), turnResult: null };
    }
  }
  return null;
}

function composeAckAndPrompt(acks: string[], nextPrompt: string): string {
  const firstAck = acks.find(Boolean);
  return firstAck ? `${firstAck} ${nextPrompt}` : nextPrompt;
}

function formatTimePreferenceAck(value: string): string {
  if (value === 'morning') return 'por la mañana';
  if (value === 'afternoon') return 'por la tarde';
  return value;
}

function composeAckAndPromptWithOptionalSideAnswer(acks: string[], nextPrompt: string, content: string): string {
  const answer = buildBriefSideAnswer(content);
  if (answer) {
    const firstAck = acks.find(Boolean);
    return firstAck ? `${firstAck} ${answer} ${nextPrompt}` : `${answer} ${nextPrompt}`;
  }
  return composeAckAndPrompt(acks, nextPrompt);
}

function buildBriefSideAnswer(content: string): string | null {
  const t = content.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/\b(precio|cuanto cuesta|tarifa|coste)\b/.test(t)) {
    return 'Sobre precio, te lo confirma recepción según valoración.';
  }
  if (/\b(duele|dolor|molesta)\b/.test(t)) {
    return 'Suele ser bien tolerado y usamos anestesia si hace falta.';
  }
  return null;
}
