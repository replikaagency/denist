import { insertMessage, getRecentMessages, type MessageInsertInput } from '@/lib/db/messages';
import { updateConversation, getConversationById } from '@/lib/db/conversations';
import { callLLM, type ChatMessage } from '@/lib/ai/completion';
import { buildSystemPrompt, getClinicConfig, FEW_SHOT_BY_INTENT } from '@/lib/conversation/prompts';
import { getMissingFields } from '@/lib/conversation/fields';
import { processTurn, type TurnResult } from '@/lib/conversation/engine';
import { AppError } from '@/lib/errors';
import { LIMITS } from '@/config/constants';

import { resolveContact, enrichContact } from './contact.service';
import {
  verifyOwnership,
  loadState,
  saveState,
  touch,
  transitionStatus,
} from './conversation.service';
import { ensureLead } from './lead.service';
import { createRequest } from './appointment.service';
import { createHandoff } from './handoff.service';

import type { Contact, Conversation, Message } from '@/types/database';

export interface ChatTurnInput {
  session_token: string;
  conversation_id: string;
  content: string;
}

export interface ChatTurnResult {
  message: Message;
  contact: Contact;
  conversation: Conversation;
  turnResult: TurnResult;
}

/**
 * Process a full chat turn: validate → persist patient msg → run AI → execute
 * side-effects → persist AI msg → return result.
 *
 * This is the single entry point called by POST /api/chat.
 */
export async function processChatMessage(input: ChatTurnInput): Promise<ChatTurnResult> {
  const { session_token, conversation_id, content } = input;

  if (content.length > LIMITS.MAX_MESSAGE_LENGTH) {
    throw AppError.validation(
      `Message exceeds maximum length of ${LIMITS.MAX_MESSAGE_LENGTH} characters`,
    );
  }

  // 1. Resolve contact
  const contact = await resolveContact(session_token);

  // 2. Verify conversation ownership
  const conversation = await verifyOwnership(conversation_id, contact.id);

  // 3. Guard: conversation must be AI-active
  if (!conversation.ai_enabled) {
    throw AppError.conflict(
      'This conversation has been handed off to a human agent. Please wait for a response.',
    );
  }
  if (conversation.status === 'resolved' || conversation.status === 'abandoned') {
    throw AppError.conflict('This conversation is closed.');
  }

  // 4. Persist patient message
  const patientMessage = await insertMessage({
    conversation_id,
    role: 'patient',
    content,
    metadata: {},
  } satisfies MessageInsertInput);

  // 5. Update last_message_at
  await touch(conversation_id);

  // 6. Load conversation state
  const state = await loadState(conversation_id);

  // 7. Build system prompt
  const systemPrompt = buildSystemPrompt(getClinicConfig(), state);

  // 8. Build message history for LLM
  const history = await getRecentMessages(conversation_id, LIMITS.CONTEXT_WINDOW);
  const llmMessages = buildLLMMessages(history);

  // 9. Inject few-shot example if available for current intent
  if (state.current_intent) {
    const isSchedulingIntent =
      state.current_intent === 'appointment_request' || state.current_intent === 'appointment_reschedule';
    const filledFields = {
      patient: state.patient,
      appointment: state.appointment,
      symptoms: state.symptoms,
    };
    const missing = getMissingFields(state.current_intent, filledFields);
    const useCompletionExample = isSchedulingIntent && missing.length === 0;

    const example = useCompletionExample
      ? FEW_SHOT_BY_INTENT['appointment_completion']
      : FEW_SHOT_BY_INTENT[state.current_intent];
    if (example) {
      llmMessages.unshift(
        { role: 'user', content: example.userMessage },
        { role: 'assistant', content: example.assistantOutput },
      );
    }
  }

  // 10. Call LLM
  const llmResult = await callLLM(systemPrompt, llmMessages);

  // 11. Process turn through the conversation engine
  const turnResult = processTurn(llmResult.text, state);

  if ('error' in turnResult) {
    throw AppError.ai(`Conversation engine error: ${turnResult.error}`);
  }

  // 12. Execute side-effects
  let updatedContact = contact;

  const hasPatientFields = turnResult.rawOutput.patient_fields &&
    Object.values(turnResult.rawOutput.patient_fields).some(v => v !== null && v !== undefined);

  if (hasPatientFields) {
    const enriched = await enrichContact(contact.id, turnResult.rawOutput.patient_fields);
    if (enriched) updatedContact = enriched;
  }

  const isIdentified = updatedContact.first_name && (updatedContact.phone || updatedContact.email);
  if (isIdentified) {
    const lead = await ensureLead(contact.id);
    await updateConversation(conversation_id, { lead_id: lead.id });
  }

  // Appointment request creation — three independent triggers so the row is
  // never silently dropped regardless of which next_action the LLM chooses:
  //
  //   1. `offer_appointment`  — canonical path: LLM is ready to offer slots.
  //   2. `confirm_details`    — LLM chose to confirm before offering; the
  //                             system prompt explicitly allows this. Create
  //                             the row now so staff see the intent even if
  //                             the patient drops off between these turns.
  //   3. `state.completed`    — engine detected all required fields are filled
  //                             but the LLM returned the wrong next_action
  //                             (defensive backstop for LLM errors).
  //
  // Guarded by isSchedulingIntent for triggers 2 & 3 so that `confirm_details`
  // on an insurance or billing turn doesn't produce a spurious appointment row.
  //
  // isIdentified (name + phone/email in the contact record) is required for
  // all paths — if the patient hasn't identified themselves yet, the request
  // is deferred to the next turn where enrichContact will have filled those in.
  //
  // createRequest is idempotent (app-level check + DB partial unique index),
  // so it's safe to call on multiple consecutive triggering turns.
  const isSchedulingIntent =
    turnResult.state.current_intent === 'appointment_request' ||
    turnResult.state.current_intent === 'appointment_reschedule';

  const appointmentActionFired =
    turnResult.rawOutput.next_action === 'offer_appointment' ||
    (turnResult.rawOutput.next_action === 'confirm_details' && isSchedulingIntent);

  const engineCompletedAppointment = turnResult.state.completed && isSchedulingIntent;

  // Deferred trigger: a prior turn fired `offer_appointment` but the patient
  // wasn't identified yet. The flag is now set in state; if they've since
  // provided their details, create the request now.
  const deferredAppointment = turnResult.state.offer_appointment_pending && isIdentified;

  if ((appointmentActionFired || engineCompletedAppointment || deferredAppointment) && isIdentified) {
    const lead = await ensureLead(contact.id);
    await createRequest({
      contactId: contact.id,
      conversationId: conversation_id,
      leadId: lead.id,
      appointment: turnResult.state.appointment,
    });
    turnResult.state.offer_appointment_pending = false;
  } else if (turnResult.rawOutput.next_action === 'offer_appointment' && !isIdentified) {
    // Patient not yet identified — remember the intent for the next turn.
    turnResult.state.offer_appointment_pending = true;
  }

  if (turnResult.escalation.shouldEscalate) {
    await createHandoff({
      conversationId: conversation_id,
      contactId: contact.id,
      escalation: turnResult.escalation,
      triggerMessageId: patientMessage.id,
    });
  }

  // Only resolve if there was no escalation — escalation takes precedence
  // and a concurrent `end_conversation` action must not clobber waiting_human.
  if (!turnResult.escalation.shouldEscalate && turnResult.rawOutput.next_action === 'end_conversation') {
    await transitionStatus(conversation_id, 'resolved');
  }

  // 13. Persist AI message
  const aiMessage = await insertMessage({
    conversation_id,
    role: 'ai',
    content: turnResult.reply,
    model: llmResult.model,
    tokens_used: llmResult.tokensUsed,
    finish_reason: llmResult.finishReason,
    latency_ms: llmResult.latencyMs,
    metadata: {
      intent: turnResult.rawOutput.intent,
      urgency: turnResult.rawOutput.urgency,
      confidence: turnResult.rawOutput.intent_confidence,
      next_action: turnResult.rawOutput.next_action,
      escalated: turnResult.escalation.shouldEscalate,
      fallback_applied: turnResult.fallback.applied,
    },
  });

  // 14. Save updated state
  await saveState(conversation_id, turnResult.state);

  // 15. Reload conversation for response
  const finalConversation = await getConversationById(conversation_id);

  return {
    message: aiMessage,
    contact: updatedContact,
    conversation: finalConversation,
    turnResult,
  };
}

/**
 * Convert DB message history to LLM ChatMessage format.
 */
function buildLLMMessages(history: Message[]): ChatMessage[] {
  return history.map((msg) => ({
    role: msg.role === 'patient' ? 'user' as const : 'assistant' as const,
    content: msg.content,
  }));
}
