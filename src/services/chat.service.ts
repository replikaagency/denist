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
import {
  createRequest,
  findOpenAppointmentRequest,
  findOpenRequestsForContact,
  isAppointmentDataComplete,
  executeReschedule,
  summarizeRequest,
} from './appointment.service';
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

  console.log('[ChatService] turn_start', {
    conversation_id,
    user_message: content.slice(0, 200),
  });

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
    // Confirmation expiry intercept
    const lastMsgTime = conversation.last_message_at ? new Date(conversation.last_message_at).getTime() : 0;
    if (lastMsgTime > 0 && Date.now() - lastMsgTime > 30 * 60 * 1000) {
      // Epired. Reset state and let it fall through to the LLM to process the patient's new message normally.
      state.awaiting_confirmation = false;
      state.pending_appointment = null;
      state.confirmation_attempts = 0;
      state.reschedule_phase = 'idle';
      state.reschedule_target_id = null;
      state.reschedule_target_summary = null;
    } else {
      const pendingAppointment = state.pending_appointment; // non-null inside this block
      const confirmation = classifyConfirmation(content);
      console.log('[ChatService] confirmation_classified', {
        conversation_id,
        result: confirmation,
      });

    if (confirmation === 'yes') {
      // Patient confirmed — resolve lead, then create or reschedule.
      const localLead = await ensureLead(contact.id);
      await updateConversation(conversation_id, { lead_id: localLead.id });

      const isReschedule = !!state.reschedule_target_id;
      let confirmReply: string;

      if (isReschedule) {
        try {
          await executeReschedule({
            oldRequestId: state.reschedule_target_id!,
            contactId: contact.id,
            conversationId: conversation_id,
            leadId: localLead.id,
            appointment: pendingAppointment,
          });
          confirmReply =
            '¡Listo! Tu cita anterior ha sido cancelada y la nueva solicitud ha quedado registrada. ' +
            'Nuestro equipo se pondrá en contacto contigo para confirmar el nuevo horario. ' +
            '¿Hay algo más en lo que pueda ayudarte?';
        } catch (err: unknown) {
          // Old request was closed between selection and confirmation (e.g. staff acted).
          // Graceful fallback: create a fresh request so the patient is not left stranded.
          console.error('[ChatService] reschedule_failed', {
            conversation_id,
            old_request_id: state.reschedule_target_id,
            error: err instanceof Error ? err.message : err,
          });
          await createRequest({
            contactId: contact.id,
            conversationId: conversation_id,
            leadId: localLead.id,
            appointment: pendingAppointment,
          });
          confirmReply =
            'Tu solicitud ha quedado registrada. Nuestro equipo se pondrá en contacto contigo para confirmar el horario. ' +
            '¿Hay algo más en lo que pueda ayudarte?';
        }
      } else {
        await createRequest({
          contactId: contact.id,
          conversationId: conversation_id,
          leadId: localLead.id,
          appointment: pendingAppointment,
        });
        confirmReply =
          '¡Perfecto! Tu solicitud de cita ha quedado registrada. Nuestro equipo se pondrá en contacto contigo para confirmar el horario. ¿Hay algo más en lo que pueda ayudarte?';
      }

      // Clear ALL confirmation + reschedule state.
      state.awaiting_confirmation = false;
      state.pending_appointment = null;
      state.confirmation_attempts = 0;
      state.appointment_request_open = true;
      state.completed = true;
      state.reschedule_phase = 'idle';
      state.reschedule_target_id = null;
      state.reschedule_target_summary = null;

      const aiMessage = await insertMessage({
        conversation_id, role: 'ai', content: confirmReply,
        metadata: { type: isReschedule ? 'reschedule_confirmed' : 'appointment_confirmed', classifier_result: 'yes', path: 'confirmation_intercept' },
      });
      const finalConversation = await saveState(conversation_id, state);
      return { message: aiMessage, contact, conversation: finalConversation, turnResult: null };
    }

    if (confirmation === 'no') {
      // Patient declined — clear all confirmation + reschedule state.
      const wasReschedule = !!state.reschedule_target_id;
      state.awaiting_confirmation = false;
      state.pending_appointment = null;
      state.confirmation_attempts = 0;
      state.reschedule_phase = 'idle';
      state.reschedule_target_id = null;
      state.reschedule_target_summary = null;
      const declineReply = wasReschedule
        ? 'Entendido, tu solicitud de cita se queda como estaba. ¿Hay algo más en lo que pueda ayudarte?'
        : 'Entendido. ¿Qué dato te gustaría cambiar? Dime la fecha, la hora o el servicio que prefieres y lo actualizo.';
      const aiMessage = await insertMessage({
        conversation_id, role: 'ai', content: declineReply,
        metadata: { type: wasReschedule ? 'reschedule_declined' : 'appointment_declined', classifier_result: 'no', path: 'confirmation_intercept' },
      });
      const finalConversation = await saveState(conversation_id, state);
      return { message: aiMessage, contact, conversation: finalConversation, turnResult: null };
    }

    // ambiguous — re-ask, and escalate after two failed attempts.
    const attempts = (state.confirmation_attempts ?? 0) + 1;
    state.confirmation_attempts = attempts;

    if (attempts >= 2) {
      console.warn('[ChatService] confirmation_escalated', { conversation_id, attempts });
      state.awaiting_confirmation = false;
      state.pending_appointment = null;
      state.confirmation_attempts = 0;
      state.reschedule_phase = 'idle';
      state.reschedule_target_id = null;
      state.reschedule_target_summary = null;
      state.escalated = true;
      state.escalation_reason = 'Patient could not confirm appointment after 2 attempts.';
      await createHandoff({
        conversationId: conversation_id,
        contactId: contact.id,
        escalation: { shouldEscalate: true, reason: state.escalation_reason, type: 'human' },
        triggerMessageId: patientMessage.id,
      });
      const escalateReply =
        'No me ha quedado claro si quieres confirmar tu solicitud. Voy a conectarte con un miembro de nuestro equipo para que puedan ayudarte directamente.';
      const aiMessage = await insertMessage({
        conversation_id, role: 'ai', content: escalateReply,
        metadata: { type: 'confirmation_escalated', classifier_result: 'ambiguous', path: 'confirmation_intercept' },
      });
      const finalConversation = await saveState(conversation_id, state);
      return { message: aiMessage, contact, conversation: finalConversation, turnResult: null };
    }

    // Ask again.
    const clarifyReply =
      'Perdona, no lo he entendido bien. ¿Confirmas la solicitud de cita? Responde "sí" para confirmar o "no" si prefieres cambiar algo.';
    const aiMessage = await insertMessage({
      conversation_id, role: 'ai', content: clarifyReply,
      metadata: { type: 'awaiting_confirmation', attempts, classifier_result: 'ambiguous', path: 'confirmation_intercept' },
    });
    const finalConversation = await saveState(conversation_id, state);
    return { message: aiMessage, contact, conversation: finalConversation, turnResult: null };
    }
  }

  // 6.7. Reschedule target-selection intercept.
  // When reschedule_phase='selecting_target' the patient is choosing from a
  // numbered list of their open appointments. Like 6.6, this bypasses the LLM.
  if (state.reschedule_phase === 'selecting_target') {
    const meta = state.metadata as Record<string, unknown>;
    const optionsCount = (meta.reschedule_options_count as number) ?? 0;
    const selection = classifyTargetSelection(content, optionsCount);

    if (selection === 'abort') {
      state.reschedule_phase = 'idle';
      state.reschedule_target_id = null;
      state.reschedule_target_summary = null;
      delete meta.reschedule_options;
      delete meta.reschedule_options_count;
      const reply = 'Entendido, dejamos las citas como están. ¿Hay algo más en lo que pueda ayudarte?';
      const aiMsg = await insertMessage({ conversation_id, role: 'ai', content: reply, metadata: { type: 'reschedule_aborted' } });
      return { message: aiMsg, contact, conversation: await saveState(conversation_id, state), turnResult: null };
    }

    if (selection === 'ambiguous') {
      const reply = 'No lo he entendido. Dime el número de la cita que quieres cambiar, o "cancelar" si prefieres dejarlo.';
      const aiMsg = await insertMessage({ conversation_id, role: 'ai', content: reply, metadata: { type: 'reschedule_selection_retry' } });
      return { message: aiMsg, contact, conversation: await saveState(conversation_id, state), turnResult: null };
    }

    // Valid numeric selection — lock the target.
    const options = (meta.reschedule_options as Array<{ id: string; summary: string }>) ?? [];
    const chosen = options[selection - 1];
    if (!chosen) {
      const reply = `Solo tienes ${options.length} cita(s) pendiente(s). Dime el número correcto o "cancelar".`;
      const aiMsg = await insertMessage({ conversation_id, role: 'ai', content: reply, metadata: { type: 'reschedule_selection_out_of_range' } });
      return { message: aiMsg, contact, conversation: await saveState(conversation_id, state), turnResult: null };
    }

    state.reschedule_target_id = chosen.id;
    state.reschedule_target_summary = chosen.summary;
    state.reschedule_phase = 'collecting_new_details';
    // Reset appointment fields so the LLM collects new preferences from scratch.
    state.appointment = { service_type: null, preferred_date: null, preferred_time: null, preferred_provider: null, flexibility: null };
    state.completed = false;
    state.offer_appointment_pending = false;
    state.appointment_request_open = false;
    delete meta.reschedule_options;
    delete meta.reschedule_options_count;

    const reply = `Perfecto, vamos a cambiar tu solicitud de cita de ${chosen.summary}.\n\n¿Para cuándo te gustaría la nueva? Dime el servicio, fecha y horario que prefieras.`;
    const aiMsg = await insertMessage({ conversation_id, role: 'ai', content: reply, metadata: { type: 'reschedule_target_locked', target_id: chosen.id } });
    return { message: aiMsg, contact, conversation: await saveState(conversation_id, state), turnResult: null };
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
  let llmResult: Awaited<ReturnType<typeof callLLM>>;
  try {
    llmResult = await callLLM(systemPrompt, llmMessages);
  } catch (err) {
    console.error('[ChatService] llm_call_failed', {
      conversation_id,
      error: err instanceof Error ? err.message : err,
    });
    const clinicPhone = process.env.CLINIC_PHONE ?? '[teléfono de la clínica]';
    const fallbackMessage = await insertMessage({
      conversation_id,
      role: 'ai',
      content: `Disculpa, ha habido un problema técnico. Por favor, contacta directamente con la clínica al ${clinicPhone}.`,
      metadata: { type: 'llm_error_fallback' },
    });
    return { message: fallbackMessage, contact, conversation, turnResult: null };
  }

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

  console.log('[ChatService] turn_processed', {
    conversation_id,
    intent: turnResult.rawOutput.intent,
    intent_confidence: turnResult.rawOutput.intent_confidence,
    fallback_applied: turnResult.fallback.applied,
  });

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

  // ── Reschedule initiation ─────────────────────────────────────────────────
  // When the LLM fires intent=appointment_reschedule and the sub-flow hasn't
  // started yet, look up the patient's open requests and branch:
  //   0 → redirect to new booking
  //   1 → auto-select; enter collecting_new_details
  //   2+ → present numbered list; enter selecting_target (handled next turn by 6.7)
  const isNewRescheduleIntent =
    turnResult.state.current_intent === 'appointment_reschedule' &&
    turnResult.state.reschedule_phase === 'idle' &&
    !turnResult.state.reschedule_target_id;

  if (isNewRescheduleIntent) {
    const openRequests = await findOpenRequestsForContact(contact.id);

    if (openRequests.length === 0) {
      turnResult.reply =
        'No encuentro ninguna cita pendiente asociada a tu cuenta. ¿Te gustaría enviar una nueva solicitud de cita?';
      turnResult.state.current_intent = 'appointment_request';
    } else if (openRequests.length === 1) {
      const target = openRequests[0];
      const summary = summarizeRequest(target);
      turnResult.state.reschedule_target_id = target.id;
      turnResult.state.reschedule_target_summary = summary;
      turnResult.state.reschedule_phase = 'collecting_new_details';
      turnResult.state.appointment = { service_type: null, preferred_date: null, preferred_time: null, preferred_provider: null, flexibility: null };
      turnResult.state.completed = false;
      turnResult.state.offer_appointment_pending = false;
      turnResult.state.appointment_request_open = false;
      turnResult.reply =
        `Veo que tienes una solicitud de cita de ${summary}. ¿Para cuándo te gustaría cambiarla? Dime la nueva fecha, horario y servicio si quieres modificarlo.`;
    } else {
      const options = openRequests.map((req) => ({ id: req.id, summary: summarizeRequest(req) }));
      turnResult.state.reschedule_phase = 'selecting_target';
      (turnResult.state.metadata as Record<string, unknown>).reschedule_options = options;
      (turnResult.state.metadata as Record<string, unknown>).reschedule_options_count = options.length;
      const listText = options.map((opt, i) => `${i + 1}. ${opt.summary}`).join('\n');
      turnResult.reply =
        `Tienes varias citas pendientes:\n\n${listText}\n\n¿Cuál quieres cambiar? Dime el número.`;
    }
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

  // Reschedule-ready: all new details collected for a reschedule → enter confirmation.
  // Runs BEFORE the generic appointment block so it takes precedence over the
  // normal new-booking path. isRescheduleCollecting guards against firing
  // when the phase was already advanced (e.g. to 'idle' after a redirect).
  const isRescheduleCollecting =
    turnResult.state.reschedule_phase === 'collecting_new_details' &&
    !!turnResult.state.reschedule_target_id;

  const isRescheduleReady =
    isRescheduleCollecting && isSchedulingIntent && appointmentDataReady && isIdentified;

  if (isRescheduleReady && (appointmentActionFired || engineCompletedAppointment || deferredAppointment)) {
    turnResult.state.awaiting_confirmation = true;
    turnResult.state.pending_appointment = { ...turnResult.state.appointment };
    turnResult.state.confirmation_attempts = 0;
    turnResult.state.completed = false;
    turnResult.state.offer_appointment_pending = false;
    turnResult.reply = buildRescheduleConfirmationSummary(
      turnResult.state.reschedule_target_summary!,
      turnResult.state.patient,
      turnResult.state.appointment,
    );
  } else if ((appointmentActionFired || engineCompletedAppointment || deferredAppointment || isCorrectionWithOpenRequest) && isIdentified) {
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

  console.log('[ChatService] turn_complete', {
    conversation_id,
    response_preview: aiMessage.content.slice(0, 150),
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
  // Intercept uncertainty phrases before YES/NO — prevents "no sé si..." from matching
  // the conditional conjunction "si" as an affirmative, which would create the appointment.
  const UNCERTAINTY = /\b(no se|no lo se|no estoy seguro|no sabria|no tengo claro)\b/;
  if (UNCERTAINTY.test(t)) return 'ambiguous';
  const YES = /\b(si|yes|confirmo|confirmar|correcto|exacto|adelante|perfecto|de acuerdo|ok|claro|por supuesto|genial|eso es|afirmo|afirmativo|dale|bueno|vamos)\b/;
  const NO = /\b(no|cancelar|cancel|mejor no|prefiero no|cambiar|espera|detener|nope|negativo|olvida|olvidalo|olvídalo)\b/;
  const CORRECTION = /\b(pero|aunque|en vez de|mejor|cambia|cambiar|no la fecha|no la hora|sino)\b/;
  if (YES.test(t)) {
    if (CORRECTION.test(t)) return 'ambiguous';
    return 'yes';
  }
  if (NO.test(t)) return 'no';
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
  if (patient.full_name) lines.push(`• Nombre: ${patient.full_name}`);
  if (appointment.service_type) lines.push(`• Servicio: ${appointment.service_type}`);
  if (appointment.preferred_date) lines.push(`• Fecha preferida: ${appointment.preferred_date}`);
  if (appointment.preferred_time) lines.push(`• Horario: ${appointment.preferred_time}`);
  if (appointment.preferred_provider) lines.push(`• Dentista: ${appointment.preferred_provider}`);
  lines.push('\n¿Confirmas que quieres registrar esta solicitud? Responde "sí" para confirmar o "no" si quieres cambiar algo.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Reschedule helpers
// ---------------------------------------------------------------------------

/**
 * Classify the patient's reply when they are selecting which appointment to
 * reschedule from a numbered list.
 *
 * Returns:
 *   number  — 1-indexed selection (always within 1..maxOptions)
 *   'abort' — patient wants to cancel the reschedule flow
 *   'ambiguous' — could not determine intent
 */
function classifyTargetSelection(
  text: string,
  maxOptions: number,
): number | 'abort' | 'ambiguous' {
  const t = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

  const ABORT = /\b(cancelar|cancel|dejalo|dejarlo|nada|ninguna|no quiero|olvidalo|mejor no|dejar)\b/;
  if (ABORT.test(t)) return 'abort';

  // Explicit digit(s)
  const numMatch = t.match(/\b(\d+)\b/);
  if (numMatch) {
    const n = parseInt(numMatch[1], 10);
    return n >= 1 && n <= maxOptions ? n : 'ambiguous';
  }

  // Spanish ordinals / number words (supports up to 4 options which covers 99% of cases)
  const ORDINAL_MAP: Record<string, number> = {
    primera: 1, primero: 1, uno: 1, una: 1,
    segunda: 2, segundo: 2, dos: 2,
    tercera: 3, tercero: 3, tres: 3,
    cuarta: 4, cuarto: 4, cuatro: 4,
  };
  for (const [word, num] of Object.entries(ORDINAL_MAP)) {
    if (t.includes(word) && num <= maxOptions) return num;
  }

  return 'ambiguous';
}

/**
 * Build a confirmation summary that shows old → new appointment details before
 * executing the atomic reschedule RPC.
 */
function buildRescheduleConfirmationSummary(
  oldSummary: string,
  patient: import('@/lib/conversation/schema').ConversationState['patient'],
  newAppointment: import('@/lib/conversation/schema').ConversationState['appointment'],
): string {
  const lines: string[] = ['Antes de hacer el cambio, confirma los datos:'];
  lines.push(`\nCita actual: ${oldSummary}`);
  lines.push('\nNueva cita:');
  if (patient.full_name) lines.push(`• Nombre: ${patient.full_name}`);
  if (newAppointment.service_type) lines.push(`• Servicio: ${newAppointment.service_type}`);
  if (newAppointment.preferred_date) lines.push(`• Fecha: ${newAppointment.preferred_date}`);
  if (newAppointment.preferred_time) lines.push(`• Horario: ${newAppointment.preferred_time}`);
  if (newAppointment.preferred_provider) lines.push(`• Dentista: ${newAppointment.preferred_provider}`);
  lines.push('\n¿Confirmas el cambio? Responde "sí" para confirmar o "no" si prefieres dejarlo como está.');
  return lines.join('\n');
}
