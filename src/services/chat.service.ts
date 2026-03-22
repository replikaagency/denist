import { insertMessage, getRecentMessages, type MessageInsertInput } from '@/lib/db/messages';
import { updateConversation } from '@/lib/db/conversations';
import { callLLM, type ChatMessage } from '@/lib/ai/completion';
import { buildSystemPrompt, getClinicConfig, FEW_SHOT_BY_INTENT } from '@/lib/conversation/prompts';
import { getMissingFields } from '@/lib/conversation/fields';
import { processTurn, type TurnResult } from '@/lib/conversation/engine';
import {
  classifyConfirmation,
  DECLINE_OFFER_FOLLOWUP_REPLY_ES,
  detectCorrectionSignals,
  isPlainDecline,
} from '@/lib/conversation/confirmation';
import { AppError } from '@/lib/errors';
import { LIMITS } from '@/config/constants';
import { log } from '@/lib/logger';

import { enrichContact } from './contact.service';
import { getContactById } from '@/lib/db/contacts';
import {
  verifyOwnership,
  loadState,
  saveState,
  touch,
  transitionStatus,
  getConversationById,
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
import { appendConversationEvent } from '@/lib/db/conversation-events';
import { getActiveHybridBookingForConversation } from '@/lib/db/hybrid-bookings';
import {
  appendHybridAckToReply,
  mergeAvailabilityCaptureReply,
  mergeDirectBookingChoiceReply,
  mergeHybridOfferTwoWaysReply,
  processHybridBookingTurn,
} from './hybrid-booking.service';

import type { Contact, Conversation, Lead, Message } from '@/types/database';

/** Age of confirmation prompt before we reset and return the patient to the LLM flow. */
const CONFIRMATION_PROMPT_TTL_MS = 30 * 60 * 1000;

/**
 * Regex-based fallback name extractor for Spanish input.
 * Returns a trimmed name string, or null if no pattern matched.
 * Used when the LLM fails to populate patient_fields.full_name.
 */
function extractNameFallback(message: string): string | null {
  const normalized = message.trim();
  const patterns = [
    /(?:me\s+llamo|mi\s+nombre\s+es|soy|llámame|me\s+llaman)\s+([A-ZÁÉÍÓÚÜÑ][a-záéíóúüñA-ZÁÉÍÓÚÜÑ]+(?:\s+[A-ZÁÉÍÓÚÜÑA-Za-záéíóúüñ][a-záéíóúüñA-Za-z]+)*)/i,
  ];
  for (const re of patterns) {
    const m = normalized.match(re);
    if (m?.[1]) {
      const name = m[1].trim();
      // Reject single-char matches and obviously non-name words
      if (name.length >= 2 && !/^\d+$/.test(name)) return name;
    }
  }
  return null;
}

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

  // 1–2. Conversation is source of truth for identity; ownership = session_token on owner contact
  let conversation = await verifyOwnership(conversation_id, session_token);
  let contact = await getContactById(conversation.contact_id);
  let effectiveContactId = conversation.contact_id;

  // 3. Guard: conversation must be AI-active
  if (!conversation.ai_enabled) {
    throw AppError.conflict(
      'Esta conversación ya ha sido transferida a un agente humano. Por favor, espera su respuesta.',
    );
  }
  if (conversation.status === 'resolved' || conversation.status === 'abandoned') {
    throw AppError.conflict('Esta conversación está cerrada.');
  }

  log('info', 'chat.turn_start', {
    conversation_id,
    user_message_preview: content.slice(0, 200),
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
  // Refresh so confirmation expiry and any later reads use DB truth (not stale pre-touch).
  conversation = await getConversationById(conversation_id);

  // 6. Load conversation state
  const state = await loadState(conversation_id);

  // 6.5. Sync appointment_request_open with DB reality BEFORE processTurn so
  // validateFlowAction inside the engine sees the correct flag.
  // Always queries — catches flag=false (prior session) AND flag=true but
  // cancelled/completed externally by staff. Result reused in appointment block.
  const preExistingRequest = await findOpenAppointmentRequest(conversation_id);
  state.appointment_request_open = !!preExistingRequest;

  const preExistingHybrid = await getActiveHybridBookingForConversation(conversation_id);
  state.hybrid_booking_open = !!preExistingHybrid;

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
    // Defensive / legacy: invariant is awaiting_confirmation ⇒ confirmation_prompt_at set.
    // Pre-hardening rows may lack the timestamp; backfill once per turn so expiry can apply.
    if (!state.confirmation_prompt_at) {
      state.confirmation_prompt_at = new Date().toISOString();
    }

    // Confirmation expiry: use the prompt timestamp (set when we first showed
    // the summary), NOT last_message_at — that updates on every patient send
    // and would make this check never fire.
    let confirmationExpired = false;
    if (state.confirmation_prompt_at) {
      const promptMs = new Date(state.confirmation_prompt_at).getTime();
      if (!Number.isNaN(promptMs) && Date.now() - promptMs > CONFIRMATION_PROMPT_TTL_MS) {
        confirmationExpired = true;
      }
    }
    // Legacy rows: awaiting_confirmation without confirmation_prompt_at — skip expiry
    // (same indefinite wait as pre-fix; new prompts always set the timestamp).

    if (confirmationExpired) {
      // Expired. Reset state and let it fall through to the LLM to process the patient's new message normally.
      state.awaiting_confirmation = false;
      state.pending_appointment = null;
      state.confirmation_attempts = 0;
      state.confirmation_prompt_at = null;
      state.reschedule_phase = 'idle';
      state.reschedule_target_id = null;
      state.reschedule_target_summary = null;
      // Persist immediately so early returns (e.g. LLM parse failure) do not leave DB stuck in awaiting_confirmation.
      conversation = await saveState(conversation_id, state);
    } else {
      const pendingAppointment = state.pending_appointment; // non-null inside this block
      let confirmation = classifyConfirmation(content);
      if (confirmation === 'yes' && !isAppointmentDataComplete(pendingAppointment)) {
        confirmation = 'ambiguous';
      }
      const canPersistBooking =
        confirmation === 'yes' &&
        isAppointmentDataComplete(pendingAppointment) &&
        !detectCorrectionSignals(content);
      log('info', 'chat.confirmation_classified', {
        conversation_id,
        result: confirmation,
        canPersistBooking,
      });

    if (canPersistBooking) {
      // Patient confirmed — resolve lead, then create or reschedule.
      const localLead = await ensureLead(effectiveContactId);
      await updateConversation(conversation_id, { lead_id: localLead.id });

      const isReschedule = !!state.reschedule_target_id;
      let confirmReply: string;

      if (isReschedule) {
        try {
          log('info', 'event.appointment_reschedule', {
            conversation_id,
            contact_id: effectiveContactId,
          });
          await executeReschedule({
            oldRequestId: state.reschedule_target_id!,
            contactId: effectiveContactId,
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
          log('error', 'chat.reschedule_failed', {
            conversation_id,
            old_request_id: state.reschedule_target_id,
            error: err instanceof Error ? err.message : err,
          });
          log('info', 'event.appointment_request_created', {
            conversation_id,
            contact_id: effectiveContactId,
            path: 'confirmation_reschedule_fallback',
          });
          await createRequest({
            contactId: effectiveContactId,
            conversationId: conversation_id,
            leadId: localLead.id,
            appointment: pendingAppointment,
          });
          confirmReply =
            'Tu cita original ya fue gestionada por el equipo. He registrado una nueva solicitud con tus nuevas preferencias. ' +
            'Te contactaremos en horario de atención para confirmar. ¿Hay algo más en lo que pueda ayudarte?';
        }
      } else {
        log('info', 'event.appointment_request_created', {
          conversation_id,
          contact_id: effectiveContactId,
          path: 'confirmation_intercept',
        });
        await createRequest({
          contactId: effectiveContactId,
          conversationId: conversation_id,
          leadId: localLead.id,
          appointment: pendingAppointment,
        });
        confirmReply =
          '¡Perfecto! Tu solicitud ha quedado registrada. Nuestro equipo te contactará en horario de atención para confirmar disponibilidad. ¿Hay algo más en lo que pueda ayudarte?';
      }

      // Clear ALL confirmation + reschedule state.
      state.awaiting_confirmation = false;
      state.pending_appointment = null;
      state.confirmation_attempts = 0;
      state.confirmation_prompt_at = null;
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
      state.confirmation_prompt_at = null;
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
      log('warn', 'chat.confirmation_escalated', { conversation_id, attempts });
      state.awaiting_confirmation = false;
      state.pending_appointment = null;
      state.confirmation_attempts = 0;
      state.confirmation_prompt_at = null;
      state.reschedule_phase = 'idle';
      state.reschedule_target_id = null;
      state.reschedule_target_summary = null;
      state.escalated = true;
      state.escalation_reason = 'Patient could not confirm appointment after 2 attempts.';
      await createHandoff({
        conversationId: conversation_id,
        contactId: effectiveContactId,
        escalation: { shouldEscalate: true, reason: state.escalation_reason, type: 'human' },
        triggerMessageId: patientMessage.id,
      });
      log('info', 'event.handoff_created', {
        conversation_id,
        contact_id: effectiveContactId,
        path: 'confirmation_escalation',
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
      'Antes de confirmar: ¿quieres cambiar algo o confirmamos tal cual? Responde "sí" para registrar la solicitud o "no" si quieres ajustar fecha, hora o servicio.';
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

  // 6.8. Post-completion "no" intercept.
  // When a booking is already registered (completed=true, appointment_request_open=true)
  // and awaiting_confirmation is false (confirmation step is done), a clear "no" from
  // the patient means dissatisfaction with the just-registered request — NOT a desire
  // to end the conversation. Without this intercept the terminal-stage LLM fires
  // end_conversation and closes the conversation while the patient is unsatisfied.
  if (state.completed && state.appointment_request_open && !state.awaiting_confirmation) {
    if (classifyConfirmation(content) === 'no') {
      const correctionInvite =
        'Entendido. ¿Qué te gustaría cambiar? Puedes decirme la fecha, la hora o el servicio y lo actualizo.';
      const aiMessage = await insertMessage({
        conversation_id, role: 'ai', content: correctionInvite,
        metadata: { type: 'post_booking_correction_invited', path: 'post_completion_intercept' },
      });
      const finalConversation = await saveState(conversation_id, state);
      return { message: aiMessage, contact, conversation: finalConversation, turnResult: null };
    }
  }

  // 6.9 Deferred appointment-offer decline (e.g. listed services, asked if they want a booking).
  // Bypass LLM so "no" cannot become escalate_human / handoff.
  if (state.offer_appointment_pending && !state.awaiting_confirmation && isPlainDecline(content)) {
    state.offer_appointment_pending = false;
    const aiMessage = await insertMessage({
      conversation_id,
      role: 'ai',
      content: DECLINE_OFFER_FOLLOWUP_REPLY_ES,
      metadata: { type: 'service_offer_declined', path: 'offer_pending_intercept' },
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
    const useCompletionExample = isSchedulingIntent && missing.length === 0
      && !state.completed && !state.appointment_request_open;

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
    log('error', 'chat.llm_call_failed', {
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
  const turnResult = processTurn(llmResult.text, state, content);

  // Phase 3: LLM parse failure — insert a fallback message instead of throwing,
  // so the patient message already persisted is not left orphaned.
  if ('error' in turnResult) {
    log('error', 'chat.llm_parse_failure', {
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

  log('info', 'chat.turn_processed', {
    conversation_id,
    intent: turnResult.rawOutput.intent,
    intent_confidence: turnResult.rawOutput.intent_confidence,
    fallback_applied: turnResult.fallback.applied,
  });

  // Phase 5: log unexpected flow overrides (engine corrected LLM's next_action)
  if (turnResult.flowValidation.overridden) {
    log('warn', 'chat.unexpected_flow', {
      conversation_id,
      original_action: turnResult.flowValidation.originalAction,
      corrected_action: turnResult.flowValidation.correctedAction,
      reason: turnResult.flowValidation.reason,
    });
  }

  // Phase 5: log when a correction was applied this turn
  if (turnResult.rawOutput.is_correction && turnResult.rawOutput.correction_fields.length > 0) {
    log('info', 'chat.correction_applied', {
      conversation_id,
      correction_fields: turnResult.rawOutput.correction_fields,
    });
  }

  // 12. Execute side-effects
  let updatedContact = contact;

  const hasPatientFields = turnResult.rawOutput.patient_fields &&
    Object.values(turnResult.rawOutput.patient_fields).some(v => v !== null && v !== undefined);

  // Fallback name extraction: if the LLM didn't populate full_name but the
  // patient's message contains a recognisable "me llamo X" pattern, inject it.
  if (!turnResult.rawOutput.patient_fields?.full_name && !state.patient.full_name) {
    const fallbackName = extractNameFallback(content);
    if (fallbackName) {
      turnResult.rawOutput.patient_fields = {
        ...turnResult.rawOutput.patient_fields,
        full_name: fallbackName,
      };
      turnResult.state.patient = { ...turnResult.state.patient, full_name: fallbackName };
      log('info', 'chat.name_fallback_applied', { fallbackName, conversation_id });
    }
  }

  if (hasPatientFields || turnResult.rawOutput.patient_fields?.full_name) {
    const enriched = await enrichContact(effectiveContactId, turnResult.rawOutput.patient_fields);
    if (enriched) {
      if (enriched.id !== effectiveContactId) {
        // Returning patient: enrichContact resolved to the canonical contact.
        // Relink this conversation so staff sees the correct identity.
        const fromContactId = effectiveContactId;
        await updateConversation(conversation_id, { contact_id: enriched.id });
        conversation = await getConversationById(conversation_id);
        log('info', 'event.merge_contact', {
          conversation_id,
          from_contact_id: fromContactId,
          to_contact_id: enriched.id,
          session_token_transferred: true,
        });
      }
      updatedContact = enriched;
      contact = enriched;
      effectiveContactId = enriched.id;
    }
  }

  // ── Reschedule initiation (after enrich) ─────────────────────────────────
  // Open requests must be looked up with the canonical contact after phone/email merge
  // on the same turn; otherwise the stub contact_id sees zero rows.
  const isNewRescheduleIntent =
    turnResult.state.current_intent === 'appointment_reschedule' &&
    turnResult.state.reschedule_phase === 'idle' &&
    !turnResult.state.reschedule_target_id;

  if (isNewRescheduleIntent) {
    const openRequests = await findOpenRequestsForContact(effectiveContactId);

    if (openRequests.length === 0) {
      if (preExistingRequest) {
        turnResult.reply =
          'Tu solicitud ya ha quedado registrada. Si quieres cambiar la fecha, ' +
          'la hora o el servicio, dímelo y preparo una nueva solicitud con la preferencia correcta.';
      } else {
        turnResult.reply =
          'No encuentro ninguna cita pendiente asociada a tu cuenta. ¿Te gustaría enviar una nueva solicitud de cita?';
        turnResult.state.current_intent = 'appointment_request';
      }
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

  // Phase 4: hoist lead — ensureLead is called at most once per turn (effectiveContactId).
  const isIdentified = updatedContact.first_name && (updatedContact.phone || updatedContact.email);
  let lead: Lead | null = null;
  if (isIdentified) {
    lead = await ensureLead(effectiveContactId);
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

  let bookingLinkShownEventEmittedThisTurn = false;
  const tryEmitBookingLinkShown = (path: string) => {
    if (bookingLinkShownEventEmittedThisTurn) return;
    bookingLinkShownEventEmittedThisTurn = true;
    appendConversationEvent({
      conversationId: conversation_id,
      contactId: effectiveContactId,
      leadId: lead?.id ?? null,
      eventType: 'booking_link_shown',
      source: 'chat',
      metadata: {
        path,
        patient_message_id: patientMessage.id,
        turn_count: turnResult.state.turn_count,
      },
    });
  };

  // Hybrid booking (direct link + structured availability) — new appointment_request only.
  let hybridDeferredStandardFlow = false;
  const bookingSelfServiceUrl = process.env.BOOKING_SELF_SERVICE_URL?.trim() ?? '';
  if (
    !turnResult.escalation.shouldEscalate &&
    isIdentified &&
    lead &&
    !hasOpenRequest &&
    turnResult.state.current_intent === 'appointment_request' &&
    turnResult.state.reschedule_phase === 'idle'
  ) {
    const hybridResult = await processHybridBookingTurn({
      conversationId: conversation_id,
      contactId: effectiveContactId,
      leadId: lead.id,
      patientMessage: content,
      state: turnResult.state,
      hybridSignal: turnResult.rawOutput.hybrid_booking,
      bookingSelfServiceUrl,
    });
    hybridDeferredStandardFlow = hybridResult.deferredStandardFlow;
    if (hybridDeferredStandardFlow) {
      turnResult.state.offer_appointment_pending = false;
      turnResult.state.awaiting_confirmation = false;
      turnResult.state.pending_appointment = null;
      turnResult.state.confirmation_prompt_at = null;
      turnResult.state.completed = false;
      const hbOut = turnResult.rawOutput.hybrid_booking;
      const choseLink =
        !!bookingSelfServiceUrl &&
        hbOut?.patient_declined_direct_link !== true &&
        (hbOut?.patient_chose_direct_link === true || hbOut?.booking_mode === 'direct_link');
      if (choseLink) {
        turnResult.reply = mergeDirectBookingChoiceReply(turnResult.reply, bookingSelfServiceUrl);
      } else if (hybridResult.capturePayload) {
        turnResult.reply = mergeAvailabilityCaptureReply(turnResult.reply, hybridResult.capturePayload);
      } else {
        turnResult.reply = appendHybridAckToReply(turnResult.reply);
      }
    } else if (
      bookingSelfServiceUrl &&
      turnResult.rawOutput.hybrid_booking?.assistant_should_offer_choice &&
      !turnResult.state.hybrid_booking_open &&
      !turnResult.state.self_service_booking_offer_shown
    ) {
      const beforeHybridOffer = turnResult.reply.trim();
      const url = bookingSelfServiceUrl.trim();
      turnResult.reply = mergeHybridOfferTwoWaysReply(turnResult.reply, bookingSelfServiceUrl);
      if (
        turnResult.reply.trim() !== beforeHybridOffer ||
        (url && turnResult.reply.includes(url) && turnResult.reply.toLowerCase().includes('dos formas'))
      ) {
        turnResult.state.self_service_booking_offer_shown = true;
        tryEmitBookingLinkShown('llm_assistant_should_offer_choice');
      }
    }
    turnResult.state.hybrid_booking_open = !!(await getActiveHybridBookingForConversation(conversation_id));
  }

  // Reschedule-ready: all new details collected for a reschedule → enter confirmation.
  // Runs BEFORE the generic appointment block so it takes precedence over the
  // normal new-booking path. isRescheduleCollecting guards against firing
  // when the phase was already advanced (e.g. to 'idle' after a redirect).
  const isRescheduleCollecting =
    turnResult.state.reschedule_phase === 'collecting_new_details' &&
    !!turnResult.state.reschedule_target_id;

  const isRescheduleReady =
    isRescheduleCollecting && isSchedulingIntent && appointmentDataReady && isIdentified;

  if (
    isRescheduleReady &&
    (appointmentActionFired || engineCompletedAppointment || deferredAppointment) &&
    !detectCorrectionSignals(content)
  ) {
    turnResult.state.awaiting_confirmation = true;
    turnResult.state.pending_appointment = { ...turnResult.state.appointment };
    turnResult.state.confirmation_attempts = 0;
    turnResult.state.confirmation_prompt_at = new Date().toISOString();
    turnResult.state.completed = false;
    turnResult.state.offer_appointment_pending = false;
    turnResult.reply = buildRescheduleConfirmationSummary(
      turnResult.state.reschedule_target_summary!,
      turnResult.state.patient,
      turnResult.state.appointment,
    );
  } else if (
    (!hybridDeferredStandardFlow || hasOpenRequest) &&
    (appointmentActionFired || engineCompletedAppointment || deferredAppointment || isCorrectionWithOpenRequest) &&
    isIdentified
  ) {
    if (hasOpenRequest) {
      // Existing request — enrich or apply correction directly.
      // Confirmation already happened on the turn that created the row.
      // lead is guaranteed non-null: isIdentified gate above ensures it was set.
      log('info', 'event.appointment_enriched', {
        conversation_id,
        contact_id: effectiveContactId,
      });
      await createRequest({
        contactId: effectiveContactId,
        conversationId: conversation_id,
        leadId: lead!.id,
        appointment: turnResult.state.appointment,
        correctionFields: turnResult.rawOutput.is_correction
          ? turnResult.rawOutput.correction_fields
          : undefined,
      });
      turnResult.state.offer_appointment_pending = false;
      turnResult.state.appointment_request_open = true;
    } else if (appointmentDataReady || appointmentActionFired || engineCompletedAppointment) {
      // First booking: enter the explicit confirmation flow unless the same message
      // signals a correction (date/time/negation) — then keep collecting.
      if (!detectCorrectionSignals(content)) {
        // No DB row is created yet — we store the snapshot in state and ask the
        // patient to confirm before writing anything.
        turnResult.state.awaiting_confirmation = true;
        turnResult.state.pending_appointment = { ...turnResult.state.appointment };
        turnResult.state.confirmation_attempts = 0;
        turnResult.state.confirmation_prompt_at = new Date().toISOString();
        turnResult.state.completed = false;        // don't lock flow until confirmed
        turnResult.state.offer_appointment_pending = false;
        turnResult.reply = buildConfirmationSummary(turnResult.state.patient, turnResult.state.appointment);
      } else {
        turnResult.state.offer_appointment_pending = true;
        turnResult.state.completed = false;
      }
    } else {
      // Appointment data still incomplete — keep deferring.
      turnResult.state.offer_appointment_pending = true;
    }
  } else if (turnResult.rawOutput.next_action === 'offer_appointment' && !isIdentified) {
    turnResult.state.offer_appointment_pending = true;
  }

  // Pre-finalization lead flush.
  // If the conversation is about to be escalated or resolved and still has no lead,
  // use accumulated state.patient as a deterministic fallback so the conversation
  // is not saved as "Anonymous" in the staff dashboard.
  // This fires when isIdentified=false on this turn (e.g. patient gave name on a
  // prior turn but not phone, or enrichContact returned null due to a duplicate),
  // yet state.patient has name + phone collected across all turns.
  const isFinalizingConversation =
    turnResult.escalation.shouldEscalate ||
    (!turnResult.escalation.shouldEscalate && turnResult.rawOutput.next_action === 'end_conversation');
  if (isFinalizingConversation && lead === null) {
    const stateIdentified = !!(state.patient.full_name && (state.patient.phone || state.patient.email));
    if (stateIdentified) {
      // Re-attempt enrichment from accumulated state if the contact record is still
      // anonymous (either enrichment hasn't run yet or returned null this turn).
      if (!updatedContact.first_name || (!updatedContact.phone && !updatedContact.email)) {
        const flushEnriched = await enrichContact(effectiveContactId, {
          full_name: state.patient.full_name,
          phone: state.patient.phone,
          email: state.patient.email,
        });
        if (flushEnriched) {
          if (flushEnriched.id !== effectiveContactId) {
            const fromContactId = effectiveContactId;
            await updateConversation(conversation_id, { contact_id: flushEnriched.id });
            conversation = await getConversationById(conversation_id);
            log('info', 'event.merge_contact', {
              conversation_id,
              from_contact_id: fromContactId,
              to_contact_id: flushEnriched.id,
              session_token_transferred: true,
            });
          }
          updatedContact = flushEnriched;
          contact = flushEnriched;
          effectiveContactId = flushEnriched.id;
        }
      }
      const flushLead = await ensureLead(effectiveContactId);
      await updateConversation(conversation_id, { lead_id: flushLead.id });
      log('info', 'chat.pre_finalization_lead_flush', {
        conversation_id,
        lead_id: flushLead.id,
        contact_id: effectiveContactId,
      });
    }
  }

  if (turnResult.escalation.shouldEscalate) {
    await createHandoff({
      conversationId: conversation_id,
      contactId: effectiveContactId,
      escalation: turnResult.escalation,
      triggerMessageId: patientMessage.id,
    });
    log('info', 'event.handoff_created', {
      conversation_id,
      contact_id: effectiveContactId,
      path: 'chat_escalation',
    });
  }

  // Only resolve if there was no escalation — escalation takes precedence
  // and a concurrent `end_conversation` action must not clobber waiting_human.
  if (!turnResult.escalation.shouldEscalate && turnResult.rawOutput.next_action === 'end_conversation') {
    await transitionStatus(conversation_id, 'resolved');
  }

  // When BOOKING_SELF_SERVICE_URL is set and the patient is in a new booking flow, ensure the
  // two-way offer appears once (state flag only — no hybrid_bookings row until the patient picks a path).
  if (
    bookingSelfServiceUrl &&
    !turnResult.escalation.shouldEscalate &&
    isIdentified &&
    lead &&
    !hasOpenRequest &&
    turnResult.state.current_intent === 'appointment_request' &&
    turnResult.state.reschedule_phase === 'idle' &&
    !hybridDeferredStandardFlow &&
    !turnResult.state.hybrid_booking_open &&
    !turnResult.state.self_service_booking_offer_shown
  ) {
    const replyBeforeOffer = turnResult.reply.trim();
    const url = bookingSelfServiceUrl.trim();
    turnResult.reply = mergeHybridOfferTwoWaysReply(turnResult.reply, bookingSelfServiceUrl);
    if (
      turnResult.reply.trim() !== replyBeforeOffer ||
      (url && turnResult.reply.includes(url) && turnResult.reply.toLowerCase().includes('dos formas'))
    ) {
      turnResult.state.self_service_booking_offer_shown = true;
      tryEmitBookingLinkShown('deterministic_offer_tail');
    }
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

  log('info', 'chat.turn_complete', {
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
 * Build a human-readable confirmation summary to send to the patient before
 * writing any appointment row to the DB.
 */
function buildConfirmationSummary(
  patient: import('@/lib/conversation/schema').ConversationState['patient'],
  appointment: import('@/lib/conversation/schema').ConversationState['appointment'],
): string {
  const lines: string[] = ['Antes de registrar tu solicitud, estos son los datos:'];
  if (patient.full_name) lines.push(`• Nombre: ${patient.full_name}`);
  if (appointment.service_type) lines.push(`• Servicio: ${appointment.service_type}`);
  if (appointment.preferred_date) lines.push(`• Fecha preferida: ${appointment.preferred_date}`);
  if (appointment.preferred_time) lines.push(`• Horario: ${appointment.preferred_time}`);
  if (appointment.preferred_provider) lines.push(`• Dentista: ${appointment.preferred_provider}`);
  lines.push(
    '\nAntes de confirmar: ¿quieres cambiar algo o confirmamos tal cual? Responde "sí" para registrar o "no" para ajustar algo.',
  );
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
  lines.push(
    '\nAntes de confirmar: ¿quieres cambiar algo o confirmamos tal cual? Responde "sí" para aplicar el cambio o "no" para dejarlo como está.',
  );
  return lines.join('\n');
}
