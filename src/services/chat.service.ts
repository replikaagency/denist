import { insertMessage, getRecentMessages, type MessageInsertInput } from '@/lib/db/messages';
import { updateConversation } from '@/lib/db/conversations';
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
import { createRequest, findOpenAppointmentRequest, isAppointmentDataComplete } from './appointment.service';
import { createHandoff } from './handoff.service';

import type { Contact, Conversation, Lead, Message } from '@/types/database';

export interface ChatTurnInput {
  session_token: string;
  conversation_id: string;
  content: string;
}

export interface ChatTurnResult {
  message: Message;
  contact: Contact;
  conversation: Conversation;
  /** null when the LLM output failed to parse and a fallback message was sent */
  turnResult: TurnResult | null;
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
  const contact = await resolveContact({ channel: 'web_chat', session_token });

  // 2. Verify conversation ownership
  const conversation = await verifyOwnership(conversation_id, contact.id);

  // 3. Guard: conversation must be AI-active
  if (!conversation.ai_enabled) {
    throw AppError.conflict(
      'Esta conversación ya ha sido transferida a un agente humano. Por favor, espera su respuesta.',
    );
  }
  if (conversation.status === 'resolved' || conversation.status === 'abandoned') {
    throw AppError.conflict('Esta conversación está cerrada.');
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

  // 6.5. Sync appointment_request_open with DB reality BEFORE processTurn so
  // validateFlowAction inside the engine sees the correct flag.
  // Always queries — catches flag=false (prior session) AND flag=true but
  // cancelled/completed externally by staff. Result reused in appointment block.
  const preExistingRequest = await findOpenAppointmentRequest(conversation_id);
  state.appointment_request_open = !!preExistingRequest;

  // If no open request exists but state.completed is true, the appointment was
  // cancelled / completed / no_showed externally by staff after the flag was
  // persisted.  Reset completed so deriveFlowStage does not return 'terminal'
  // and the patient can re-enter the booking flow on this turn.
  //
  // This is safe on the normal completion path because:
  //   - Turn N:   appointment created → preExistingRequest found → reset does NOT fire
  //   - Turn N+1: completed set to true inside processTurn → preExistingRequest still
  //               found (row unchanged) → reset does NOT fire
  //   - Post-cancellation: preExistingRequest=null AND completed=true → reset fires ✓
  if (!preExistingRequest && state.completed) {
    state.completed = false;
  }

  // 6.6. Explicit confirmation intercept.
  // When the previous turn set awaiting_confirmation=true we do NOT run a full
  // LLM turn — we only classify the patient's reply as yes / no / ambiguous
  // and execute the corresponding branch.  The LLM is intentionally bypassed
  // so a "sí" cannot be misclassified or rewritten by any fallback rule.
  if (state.awaiting_confirmation && state.pending_appointment) {
    const pendingAppointment = state.pending_appointment; // non-null inside this block
    const confirmation = classifyConfirmation(content);

    if (confirmation === 'yes') {
      // Patient confirmed — resolve lead and create the appointment row.
      const localLead = await ensureLead(contact.id);
      await updateConversation(conversation_id, { lead_id: localLead.id });
      await createRequest({
        contactId: contact.id,
        conversationId: conversation_id,
        leadId: localLead.id,
        appointment: pendingAppointment,
      });
      state.awaiting_confirmation = false;
      state.pending_appointment = null;
      state.confirmation_attempts = 0;
      state.appointment_request_open = true;
      state.completed = true;
      const confirmReply =
        '¡Perfecto! Tu solicitud de cita ha quedado registrada. Nuestro equipo se pondrá en contacto contigo para confirmar el horario. ¿Hay algo más en lo que pueda ayudarte?';
      const aiMessage = await insertMessage({
        conversation_id, role: 'ai', content: confirmReply,
        metadata: { type: 'appointment_confirmed' },
      });
      const finalConversation = await saveState(conversation_id, state);
      return { message: aiMessage, contact, conversation: finalConversation, turnResult: null };
    }

    if (confirmation === 'no') {
      // Patient declined — clear confirmation state so they can restart/change.
      state.awaiting_confirmation = false;
      state.pending_appointment = null;
      state.confirmation_attempts = 0;
      const declineReply =
        'Entendido, no hay problema. ¿Te gustaría cambiar algún detalle o hay algo más en lo que pueda ayudarte?';
      const aiMessage = await insertMessage({
        conversation_id, role: 'ai', content: declineReply,
        metadata: { type: 'appointment_declined' },
      });
      const finalConversation = await saveState(conversation_id, state);
      return { message: aiMessage, contact, conversation: finalConversation, turnResult: null };
    }

    // ambiguous — re-ask, and escalate after two failed attempts.
    const attempts = (state.confirmation_attempts ?? 0) + 1;
    state.confirmation_attempts = attempts;

    if (attempts >= 2) {
      state.awaiting_confirmation = false;
      state.escalated = true;
      state.escalation_reason = 'Patient could not confirm appointment after 2 attempts.';
      await createHandoff({
        conversationId: conversation_id,
        contactId: contact.id,
        escalation: { shouldEscalate: true, reason: state.escalation_reason, type: 'human' },
        triggerMessageId: patientMessage.id,
      });
      const escalateReply =
        'No me ha quedado claro si quieres confirmar la cita. Voy a conectarte con un miembro de nuestro equipo para que puedan ayudarte directamente.';
      const aiMessage = await insertMessage({
        conversation_id, role: 'ai', content: escalateReply,
        metadata: { type: 'confirmation_escalated' },
      });
      const finalConversation = await saveState(conversation_id, state);
      return { message: aiMessage, contact, conversation: finalConversation, turnResult: null };
    }

    // Ask again.
    const clarifyReply =
      'Perdona, no lo he entendido bien. ¿Confirmas la solicitud de cita? Responde **sí** para confirmar o **no** si prefieres cambiar algo.';
    const aiMessage = await insertMessage({
      conversation_id, role: 'ai', content: clarifyReply,
      metadata: { type: 'awaiting_confirmation', attempts },
    });
    const finalConversation = await saveState(conversation_id, state);
    return { message: aiMessage, contact, conversation: finalConversation, turnResult: null };
  }

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

  // Phase 3: LLM parse failure — insert a fallback message instead of throwing,
  // so the patient message already persisted is not left orphaned.
  if ('error' in turnResult) {
    console.error('[ChatService] LLM parse failure', {
      conversation_id,
      error: turnResult.error,
    });
    const fallbackMessage = await insertMessage({
      conversation_id,
      role: 'ai',
      content: 'Lo siento, no te he entendido bien. ¿Podrías repetirlo de otra forma?',
      metadata: { type: 'parse_error_fallback' },
    });
    return {
      message: fallbackMessage,
      contact,
      conversation,
      turnResult: null,
    };
  }

  // Phase 5: log unexpected flow overrides (engine corrected LLM's next_action)
  if (turnResult.flowValidation.overridden) {
    console.warn('[ChatService] unexpected_flow', {
      conversation_id,
      original_action: turnResult.flowValidation.originalAction,
      corrected_action: turnResult.flowValidation.correctedAction,
      reason: turnResult.flowValidation.reason,
    });
  }

  // Phase 5: log when a correction was applied this turn
  if (turnResult.rawOutput.is_correction && turnResult.rawOutput.correction_fields.length > 0) {
    console.log('[ChatService] correction_applied', {
      conversation_id,
      correction_fields: turnResult.rawOutput.correction_fields,
    });
  }

  // 12. Execute side-effects
  let updatedContact = contact;

  const hasPatientFields = turnResult.rawOutput.patient_fields &&
    Object.values(turnResult.rawOutput.patient_fields).some(v => v !== null && v !== undefined);

  if (hasPatientFields) {
    const enriched = await enrichContact(contact.id, turnResult.rawOutput.patient_fields);
    if (enriched) {
      updatedContact = enriched;
    } else {
      // Phase 3: null means a duplicate phone/email was detected — log and continue.
      console.warn('[ChatService] enrichContact returned null — possible duplicate phone/email', {
        conversation_id,
        contact_id: contact.id,
      });
    }
  }

  // Phase 4: hoist lead — ensureLead is called at most once per turn.
  const isIdentified = updatedContact.first_name && (updatedContact.phone || updatedContact.email);
  let lead: Lead | null = null;
  if (isIdentified) {
    lead = await ensureLead(contact.id);
    await updateConversation(conversation_id, { lead_id: lead.id });
  }

  // Appointment request creation — four triggers (all validated by flow controller):
  //   1. `offer_appointment`         — canonical path.
  //   2. `confirm_details`           — LLM confirmed before offering (scheduling intent only).
  //   3. `state.completed`           — engine backstop: all fields filled.
  //   4. isCorrectionWithOpenRequest — patient corrected a field; enrich the existing row
  //                                    even when next_action is 'continue'.
  //   deferred                       — offer_appointment_pending from a prior turn.
  const isSchedulingIntent =
    turnResult.state.current_intent === 'appointment_request' ||
    turnResult.state.current_intent === 'appointment_reschedule';

  const appointmentActionFired =
    turnResult.rawOutput.next_action === 'offer_appointment' ||
    (turnResult.rawOutput.next_action === 'confirm_details' && isSchedulingIntent);

  const deferredAppointment = turnResult.state.offer_appointment_pending && isIdentified;

  // preExistingRequest was fetched in step 6.5 (or null if flag was already true).
  // hasOpenRequest is true when a request was found pre-turn OR the flag was
  // already persisted from a previous turn.
  // Declared before engineCompletedAppointment — the guard depends on it.
  const hasOpenRequest = isIdentified &&
    (!!preExistingRequest || turnResult.state.appointment_request_open);

  const appointmentDataReady = isAppointmentDataComplete(turnResult.state.appointment);

  // Only act as a backstop when the booking is complete but no appointment row
  // exists yet (e.g. completed was set but creation was deferred due to missing
  // identity).  Adding !hasOpenRequest prevents this from firing on every turn
  // once completed=true — it was never meant to run when a request is already open.
  const engineCompletedAppointment = turnResult.state.completed && isSchedulingIntent && !hasOpenRequest;

  // Explicit correction trigger: fires when the patient corrected one or more
  // appointment/symptom fields AND an open request already exists.
  // Requires hasOpenRequest so createRequest() always takes the enrich path —
  // this trigger cannot create a new appointment row.
  // Uses rawOutput (not state) because is_correction / correction_fields are
  // LLM output fields, not persisted ConversationState fields.
  const isCorrectionWithOpenRequest =
    turnResult.rawOutput.is_correction === true &&
    turnResult.rawOutput.correction_fields.length > 0 &&
    hasOpenRequest === true;

  if ((appointmentActionFired || engineCompletedAppointment || deferredAppointment || isCorrectionWithOpenRequest) && isIdentified) {
    if (hasOpenRequest) {
      // Existing request — enrich or apply correction directly.
      // Confirmation already happened on the turn that created the row.
      // lead is guaranteed non-null: isIdentified gate above ensures it was set.
      await createRequest({
        contactId: contact.id,
        conversationId: conversation_id,
        leadId: lead!.id,
        appointment: turnResult.state.appointment,
        correctionFields: turnResult.rawOutput.is_correction
          ? turnResult.rawOutput.correction_fields
          : undefined,
      });
      turnResult.state.offer_appointment_pending = false;
      turnResult.state.appointment_request_open = true;
    } else if (appointmentDataReady) {
      // First booking: enter the explicit confirmation flow.
      // No DB row is created yet — we store the snapshot in state and ask the
      // patient to confirm before writing anything.
      turnResult.state.awaiting_confirmation = true;
      turnResult.state.pending_appointment = { ...turnResult.state.appointment };
      turnResult.state.confirmation_attempts = 0;
      turnResult.state.completed = false;        // don't lock flow until confirmed
      turnResult.state.offer_appointment_pending = false;
      // Override the LLM reply with a structured confirmation summary.
      turnResult.reply = buildConfirmationSummary(turnResult.state.patient, turnResult.state.appointment);
    } else {
      // Appointment data still incomplete — keep deferring.
      turnResult.state.offer_appointment_pending = true;
    }
  } else if (turnResult.rawOutput.next_action === 'offer_appointment' && !isIdentified) {
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

  // 14. Save updated state — returns updated Conversation, eliminating a second DB read.
  const finalConversation = await saveState(conversation_id, turnResult.state);

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

// ---------------------------------------------------------------------------
// Explicit appointment confirmation helpers
// ---------------------------------------------------------------------------

/**
 * Classify the patient's reply as a yes, no, or ambiguous confirmation.
 * Accent-normalized so "sí" → "si" matches without diacritic handling in regex.
 */
function classifyConfirmation(text: string): 'yes' | 'no' | 'ambiguous' {
  const t = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const YES = /\b(si|yes|confirmo|confirmar|correcto|exacto|adelante|perfecto|de acuerdo|ok|claro|por supuesto|genial|eso es|afirmo|afirmativo|dale|bueno|vamos|va)\b/;
  const NO  = /\b(no|cancelar|cancel|mejor no|prefiero no|cambiar|cambio|espera|para|detener|nope|negativo|olvida|olvidalo|olvídalo)\b/;
  if (YES.test(t)) return 'yes';
  if (NO.test(t))  return 'no';
  return 'ambiguous';
}

/**
 * Build a human-readable confirmation summary to send to the patient before
 * writing any appointment row to the DB.
 */
function buildConfirmationSummary(
  patient: import('@/lib/conversation/schema').ConversationState['patient'],
  appointment: import('@/lib/conversation/schema').ConversationState['appointment'],
): string {
  const lines: string[] = ['Antes de registrar tu solicitud, déjame confirmarte los datos:'];
  if (patient.full_name)           lines.push(`• Nombre: ${patient.full_name}`);
  if (appointment.service_type)    lines.push(`• Servicio: ${appointment.service_type}`);
  if (appointment.preferred_date)  lines.push(`• Fecha preferida: ${appointment.preferred_date}`);
  if (appointment.preferred_time)  lines.push(`• Horario: ${appointment.preferred_time}`);
  if (appointment.preferred_provider) lines.push(`• Dentista: ${appointment.preferred_provider}`);
  lines.push('\n¿Confirmas que quieres registrar esta solicitud? Responde **sí** para confirmar o **no** si quieres cambiar algo.');
  return lines.join('\n');
}
