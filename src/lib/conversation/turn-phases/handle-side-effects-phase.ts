import { insertMessage } from '@/lib/db/messages';
import { updateConversation } from '@/lib/db/conversations';
import { callLLM } from '@/lib/ai/completion';
import { getMissingFields, fieldQueryOptionsFromState } from '@/lib/conversation/fields';
import { detectCorrectionSignals } from '@/lib/conversation/confirmation';
import { log } from '@/lib/logger';
import {
  buildConfirmationSummary,
  buildRescheduleConfirmationSummary,
} from '@/lib/conversation/response-builder';
import { getNextPromptForIntentFromState, resetAppointmentDraft } from '@/lib/conversation/booking.service';
import {
  extractNameGuard,
  extractPhoneGuard,
  extractEmailGuard,
  hydrateStatePatientFromContact,
} from '@/lib/conversation/intake-guards';
import { saveState, transitionStatus, getConversationById } from '@/services/conversation.service';
import { enrichContact } from '@/services/contact.service';
import { ensureLead } from '@/services/lead.service';
import {
  createRequest,
  findOpenRequestsForContact,
  isAppointmentDataComplete,
  summarizeRequest,
} from '@/services/appointment.service';
import { createHandoff } from '@/services/handoff.service';
import { appendConversationEvent } from '@/lib/db/conversation-events';
import { mergeHybridOfferTwoWaysReply } from '@/services/hybrid-booking.service';
import {
  cancelRealAppointment,
  findLatestActiveAppointmentByPhone,
} from '@/services/real-booking.service';
import type { TurnResult } from '@/lib/conversation/engine';
import {
  turnPhaseComplete,
  type TurnPhaseEnv,
  type TurnPhaseResult,
} from '@/lib/conversation/turn-phases/types';
import type { Lead } from '@/types/database';
import { applyHybridBookingPhase } from '@/lib/conversation/turn-phases/handle-hybrid-phase';
import { TurnEngineBranch } from '@/lib/conversation/turn-engine-branches';
import { logTurnEngineBranch } from '@/lib/conversation/turn-engine-log';

type LlmResult = Awaited<ReturnType<typeof callLLM>>;

/** Post-LLM: enrich, reschedule init, appointments, hybrid, handoff, persist AI message + state. */
export async function runSideEffectsPhase(
  env: TurnPhaseEnv,
  turnResult: TurnResult,
  llmResult: LlmResult,
): Promise<TurnPhaseResult> {
  const { conversation_id, content, routedContent, patientMessage, state, refs, preExistingRequest } = env;
  let { conversation, contact, effectiveContactId } = refs;

  let updatedContact = contact;

  const hasAnyPatientFields = (fields: typeof turnResult.rawOutput.patient_fields) =>
    !!fields && Object.values(fields).some((v) => v !== null && v !== undefined);

  if (!turnResult.rawOutput.patient_fields?.full_name && !turnResult.state.patient.full_name) {
    const name = extractNameGuard(content);
    if (name) {
      turnResult.rawOutput.patient_fields = { ...turnResult.rawOutput.patient_fields, full_name: name };
      turnResult.state.patient = { ...turnResult.state.patient, full_name: name };
      log('info', 'chat.name_guard_applied', { name, conversation_id });
    }
  }
  if (!turnResult.rawOutput.patient_fields?.phone && !turnResult.state.patient.phone) {
    const phone = extractPhoneGuard(content);
    if (phone) {
      turnResult.rawOutput.patient_fields = { ...turnResult.rawOutput.patient_fields, phone };
      turnResult.state.patient = { ...turnResult.state.patient, phone };
      log('info', 'chat.phone_guard_applied', { conversation_id });
    }
  }
  if (!turnResult.rawOutput.patient_fields?.email && !turnResult.state.patient.email) {
    const email = extractEmailGuard(content);
    if (email) {
      turnResult.rawOutput.patient_fields = { ...turnResult.rawOutput.patient_fields, email };
      turnResult.state.patient = { ...turnResult.state.patient, email };
      log('info', 'chat.email_guard_applied', { conversation_id });
    }
  }

  if (hasAnyPatientFields(turnResult.rawOutput.patient_fields)) {
    const enriched = await enrichContact(effectiveContactId, turnResult.rawOutput.patient_fields);
    if (enriched) {
      if (enriched.id !== effectiveContactId) {
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
      refs.contact = enriched;
      refs.effectiveContactId = enriched.id;
      refs.conversation = conversation;
      hydrateStatePatientFromContact(turnResult.state, updatedContact, { includeEmail: true });
    }
  }

  const isNewRescheduleIntent =
    turnResult.state.current_intent === 'appointment_reschedule' &&
    turnResult.state.reschedule_phase === 'idle' &&
    !turnResult.state.reschedule_target_id;

  if (isNewRescheduleIntent) {
    const openRequests = await findOpenRequestsForContact(effectiveContactId);

    if (openRequests.length === 0) {
      if (preExistingRequest) {
        turnResult.reply =
          'Tu solicitud ya está registrada. Si quieres cambiar fecha, hora o servicio, ' +
          'dímelo y preparo una nueva solicitud con esa preferencia.';
      } else {
        turnResult.reply =
          'No encuentro ninguna solicitud pendiente asociada a tu cuenta. ¿Quieres registrar una nueva solicitud de cita?';
        turnResult.state.current_intent = 'appointment_request';
      }
    } else if (openRequests.length === 1) {
      const target = openRequests[0];
      const summary = summarizeRequest(target);
      turnResult.state.reschedule_target_id = target.id;
      turnResult.state.reschedule_target_summary = summary;
      turnResult.state.reschedule_phase = 'collecting_new_details';
      resetAppointmentDraft(turnResult.state);
      turnResult.reply =
        `Veo que tienes una solicitud de cita de ${summary}. ${
          getNextPromptForIntentFromState(
            turnResult.state,
            turnResult.state.current_intent ?? 'appointment_reschedule',
          )?.prompt ?? '¿Qué día te viene mejor?'
        }`;
    } else {
      const options = openRequests.map((req) => ({ id: req.id, summary: summarizeRequest(req) }));
      turnResult.state.reschedule_phase = 'selecting_target';
      (turnResult.state.metadata as Record<string, unknown>).reschedule_options = options;
      (turnResult.state.metadata as Record<string, unknown>).reschedule_options_count = options.length;
      const listText = options.map((opt, i) => `${i + 1}. ${opt.summary}`).join('\n');
      turnResult.reply =
        `Tienes varias solicitudes pendientes:\n\n${listText}\n\nPulsa la que quieres cambiar o dime el número.`;
    }
  }

  const isIdentified = updatedContact.first_name && (updatedContact.phone || updatedContact.email);
  let lead: Lead | null = null;
  if (isIdentified) {
    lead = await ensureLead(effectiveContactId);
    await updateConversation(conversation_id, { lead_id: lead.id });
  }

  const isSchedulingIntent =
    turnResult.state.current_intent === 'appointment_request' ||
    turnResult.state.current_intent === 'appointment_reschedule';

  const appointmentActionFired =
    turnResult.rawOutput.next_action === 'offer_appointment' ||
    (turnResult.rawOutput.next_action === 'confirm_details' && isSchedulingIntent);

  const deferredAppointment = turnResult.state.offer_appointment_pending && isIdentified;

  const hasOpenRequest =
    isIdentified && (!!preExistingRequest || turnResult.state.appointment_request_open);

  const appointmentDataReady = isAppointmentDataComplete(turnResult.state.appointment);

  const engineCompletedAppointment = turnResult.state.completed && isSchedulingIntent && !hasOpenRequest;

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

  const bookingSelfServiceUrl = process.env.BOOKING_SELF_SERVICE_URL?.trim() ?? '';
  let hybridDeferredStandardFlow = false;
  if (lead) {
    hybridDeferredStandardFlow = await applyHybridBookingPhase({
      conversation_id,
      routedContent,
      effectiveContactId,
      lead,
      isIdentified: !!isIdentified,
      hasOpenRequest,
      turnResult,
      bookingSelfServiceUrl,
      tryEmitBookingLinkShown,
    });
  }

  const isRescheduleCollecting =
    turnResult.state.reschedule_phase === 'collecting_new_details' &&
    !!turnResult.state.reschedule_target_id;

  const isRescheduleReady =
    isRescheduleCollecting && isSchedulingIntent && appointmentDataReady && isIdentified;

  if (
    isRescheduleReady &&
    (appointmentActionFired || engineCompletedAppointment || deferredAppointment) &&
    !detectCorrectionSignals(routedContent)
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
      if (!detectCorrectionSignals(routedContent)) {
        turnResult.state.awaiting_confirmation = true;
        turnResult.state.pending_appointment = { ...turnResult.state.appointment };
        turnResult.state.confirmation_attempts = 0;
        turnResult.state.confirmation_prompt_at = new Date().toISOString();
        turnResult.state.completed = false;
        turnResult.state.offer_appointment_pending = false;
        turnResult.reply = buildConfirmationSummary(turnResult.state.patient, turnResult.state.appointment);
      } else {
        turnResult.state.offer_appointment_pending = true;
        turnResult.state.completed = false;
      }
    } else {
      turnResult.state.offer_appointment_pending = true;
    }
  } else if (turnResult.rawOutput.next_action === 'offer_appointment' && !isIdentified) {
    turnResult.state.offer_appointment_pending = true;
  }

  const isFinalizingConversation =
    turnResult.escalation.shouldEscalate ||
    (!turnResult.escalation.shouldEscalate && turnResult.rawOutput.next_action === 'end_conversation');
  if (isFinalizingConversation && lead === null) {
    const stateIdentified = !!(state.patient.full_name && (state.patient.phone || state.patient.email));
    if (stateIdentified) {
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
          refs.contact = flushEnriched;
          refs.effectiveContactId = flushEnriched.id;
          refs.conversation = conversation;
          hydrateStatePatientFromContact(turnResult.state, updatedContact, { includeEmail: true });
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

  if (!turnResult.escalation.shouldEscalate && turnResult.rawOutput.next_action === 'end_conversation') {
    await transitionStatus(conversation_id, 'resolved');
  }

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

  if (
    turnResult.state.current_intent === 'appointment_cancel' &&
    !turnResult.escalation.shouldEscalate &&
    updatedContact.phone
  ) {
    const latest = await findLatestActiveAppointmentByPhone(updatedContact.phone);
    if (latest?.id) {
      const cancelResult = await cancelRealAppointment({ appointment_id: latest.id });
      if (cancelResult.success) {
        turnResult.reply =
          'He dejado la cita cancelada. Si quieres, te ayudo a reservar otra en otro horario.';
      }
    }
  }

  const missingAfterTurn = turnResult.state.current_intent
    ? getMissingFields(
        turnResult.state.current_intent,
        {
          patient: turnResult.state.patient,
          appointment: turnResult.state.appointment,
          symptoms: turnResult.state.symptoms,
        },
        fieldQueryOptionsFromState(turnResult.state),
      )
    : [];
  const isAskingPatientStatus =
    !turnResult.escalation.shouldEscalate &&
    !turnResult.state.awaiting_confirmation &&
    turnResult.rawOutput.next_action === 'ask_field' &&
    missingAfterTurn[0] === 'patient.new_or_returning';
  const isAskingTimePreference =
    !turnResult.escalation.shouldEscalate &&
    !turnResult.state.awaiting_confirmation &&
    turnResult.rawOutput.next_action === 'ask_field' &&
    missingAfterTurn[0] === 'appointment.preferred_time';
  const patientStatusChoiceMetadata = isAskingPatientStatus
    ? {
        type: 'patient_status_choice',
        field: 'new_or_returning',
        options: [
          { label: 'Es mi primera vez', value: 'patient_status_new' },
          { label: 'Ya he venido antes', value: 'patient_status_returning' },
        ],
      }
    : {};
  const timePreferenceChoiceMetadata = isAskingTimePreference
    ? {
        type: 'time_preference_choice',
        field: 'preferred_time',
        options: [
          { label: 'Mañana', value: 'time_morning' },
          { label: 'Tarde', value: 'time_afternoon' },
          { label: 'Hora concreta', value: 'time_exact' },
        ],
      }
    : {};
  const requestSelectionOptions =
    turnResult.state.reschedule_phase === 'selecting_target'
      ? (((turnResult.state.metadata as Record<string, unknown>).reschedule_options as
          | Array<{ id: string; summary: string }>
          | undefined) ?? [])
      : [];
  const requestSelectionMetadata =
    requestSelectionOptions.length > 0
      ? {
          type: 'request_selection',
          options: requestSelectionOptions.map((opt) => ({ label: opt.summary, value: opt.id })),
        }
      : {};

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
      ...patientStatusChoiceMetadata,
      ...timePreferenceChoiceMetadata,
      ...requestSelectionMetadata,
      ...(turnResult.state.awaiting_confirmation
        ? {
            type: 'awaiting_confirmation',
            options: [
              { label: 'Confirmar', value: 'confirm_yes' },
              { label: 'Cambiar datos', value: 'confirm_change' },
            ],
          }
        : {}),
    },
  });

  log('info', 'chat.turn_complete', {
    conversation_id,
    response_preview: aiMessage.content.slice(0, 150),
  });

  const finalConversation = await saveState(conversation_id, turnResult.state);
  refs.conversation = finalConversation;

  logTurnEngineBranch({
    conversationId: conversation_id,
    branchTaken: TurnEngineBranch.sideEffects.persistReply,
    reason: `Persisted AI reply (next_action=${turnResult.rawOutput.next_action}, escalated=${turnResult.escalation.shouldEscalate}).`,
    inputSummary: routedContent,
    state: turnResult.state,
  });

  return turnPhaseComplete(
    {
      message: aiMessage,
      contact: updatedContact,
      conversation: finalConversation,
      turnResult,
    },
    { branchTaken: 'side_effects_llm_path_complete' },
  );
}
