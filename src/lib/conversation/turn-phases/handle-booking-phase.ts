import { insertMessage } from '@/lib/db/messages';
import { log } from '@/lib/logger';
import { logConversationFlow } from '@/lib/logger/flow-logger';
import {
  isOptionalEmailFollowupOpen,
  isReceptionPhoneStrictGateActive,
  isStrictBinaryFlowOpen,
} from '@/lib/conversation/flow-rules';
import { buildGuidedFieldMetadata } from '@/lib/conversation/guided-field-metadata';
import {
  classifyConfirmation,
  DECLINE_OFFER_FOLLOWUP_REPLY_ES,
  isFrustrationSignal,
  FRUSTRATION_ESCALATION_REPLY_ES,
  isPlainDecline,
} from '@/lib/conversation/confirmation';
import {
  BOOKING_PATH_STRICT_PROMPT,
  ASAP_SLOT_INVALID_REPLY,
  CORRECTION_CHOICE_OPTIONS,
  EMAIL_FOLLOWUP_OPTIONS,
  GREETING_CANONICAL_REPLY,
  OPTIONAL_EMAIL_STRICT_PROMPT,
  QUICK_BOOKING_PATH_OPTIONS,
  RECEPTION_PHONE_GATE_INVALID_REPLY,
  SIMPLE_INFO_INTENT_REPLY,
  buildReceptionCapturePrompt,
  isSimpleAckOnly,
  isSimpleGoodbyeOnly,
  isSimpleGreetingOnly,
  isSimpleInfoIntent,
  isSimpleThanksOnly,
} from '@/lib/conversation/response-builder';
import {
  classifyTargetSelection,
  getNextPromptForIntentFromState,
  isQuickBookingEntryIntent,
  parseBookingPathSelection,
  parseStrictOneTwoChoice,
  resetAppointmentDraft,
} from '@/lib/conversation/booking.service';
import { extractPhoneGuard } from '@/lib/conversation/intake-guards';
import { saveState, getConversationById } from '@/services/conversation.service';
import { createHandoff } from '@/services/handoff.service';
import {
  turnPhaseComplete,
  turnPhaseNotHandled,
  type TurnPhaseEnv,
  type TurnPhaseResult,
} from '@/lib/conversation/turn-phases/types';
import {
  applyAsapSlotProposalToState,
  parseAsapSlotChoice,
  type AsapSlotProposal,
} from '@/lib/conversation/booking-intent';
import { TurnEngineBranch } from '@/lib/conversation/turn-engine-branches';
import type { TurnEngineBranchId } from '@/lib/conversation/turn-engine-branches';
import { logTurnEngineBranch } from '@/lib/conversation/turn-engine-log';

/**
 * Legacy `conversation_flow` (`logConversationFlow`) + stable `turn_engine.branch` (`logTurnEngineBranch`).
 * The two `branch_taken` strings use different naming contracts on purpose — do not assume they match.
 */
function logPreLlmBookingFlow(
  env: TurnPhaseEnv,
  legacyFlowBranch: string,
  flowReason: string,
  engineBranch: TurnEngineBranchId,
  engineReason: string,
): void {
  const { conversation_id, routedContent, state } = env;
  logConversationFlow({
    conversation_id,
    phone: state.patient.phone ?? null,
    step: 'booking',
    input: routedContent,
    branch_taken: legacyFlowBranch,
    reason: flowReason,
  });
  logTurnEngineBranch({
    conversationId: conversation_id,
    branchTaken: engineBranch,
    reason: engineReason,
    inputSummary: routedContent,
    state,
  });
}

function logPreLlmSocial(env: TurnPhaseEnv, engineBranch: TurnEngineBranchId, engineReason: string): void {
  logTurnEngineBranch({
    conversationId: env.conversation_id,
    branchTaken: engineBranch,
    reason: engineReason,
    inputSummary: env.routedContent,
    state: env.state,
  });
}

function logPostBookingBranch(env: TurnPhaseEnv, engineBranch: TurnEngineBranchId, engineReason: string): void {
  logTurnEngineBranch({
    conversationId: env.conversation_id,
    branchTaken: engineBranch,
    reason: engineReason,
    inputSummary: env.routedContent,
    state: env.state,
  });
}

/** Quick booking, path choice, ASAP slots, reception phone validation, social shortcuts (pre-LLM). */
export async function tryPreLlmBookingPhase(env: TurnPhaseEnv): Promise<TurnPhaseResult> {
  const { conversation_id, routedContent, state, stateMeta, refs } = env;
  const { contact } = refs;

  const canEnterQuickBooking =
    !state.awaiting_confirmation &&
    !state.appointment_request_open &&
    !state.completed &&
    state.reschedule_phase === 'idle' &&
    !state.reschedule_target_id &&
    state.current_intent !== 'appointment_reschedule';
  const bookingPathChoice =
    stateMeta.booking_path_choice_open === true ? parseBookingPathSelection(routedContent) : null;

  if (stateMeta.booking_path_choice_open === true && !bookingPathChoice) {
    logPreLlmBookingFlow(
      env,
      'quick_booking_path_strict_retry',
      'invalid_path_choice',
      TurnEngineBranch.booking.pathChoiceInvalid,
      'Input did not parse as quick booking path option 1 or 2.',
    );
    const strictChoiceMessage = await insertMessage({
      conversation_id,
      role: 'ai',
      content: BOOKING_PATH_STRICT_PROMPT,
      metadata: { type: 'quick_booking_path_choice', options: QUICK_BOOKING_PATH_OPTIONS },
    });
    return turnPhaseComplete(
      {
        message: strictChoiceMessage,
        contact,
        conversation: await saveState(conversation_id, state),
        turnResult: null,
      },
      { branchTaken: 'quick_booking_path_strict_retry' },
    );
  }
  if (
    (routedContent === 'quick_booking_fast' || isQuickBookingEntryIntent(routedContent)) &&
    canEnterQuickBooking
  ) {
    state.current_intent = 'appointment_request';
    state.completed = false;
    const selfServiceUrlQuick = process.env.BOOKING_SELF_SERVICE_URL?.trim() ?? '';
    if (selfServiceUrlQuick) {
      logPreLlmBookingFlow(
        env,
        'quick_booking_entry',
        'self_service_url_open_path_choice',
        TurnEngineBranch.booking.quickEntryPathChoice,
        'Self-service URL configured; quick booking 1/2 path choice opened.',
      );
      stateMeta.booking_path_choice_open = true;
      const aiMessage = await insertMessage({
        conversation_id,
        role: 'ai',
        content:
          'Perfecto. ¿Cómo prefieres hacerlo?\n\n1. Elegir hora directamente\n2. Dejar preferencia para que recepción me contacte',
        metadata: {
          type: 'quick_booking_path_choice',
          options: QUICK_BOOKING_PATH_OPTIONS,
        },
      });
      const finalConversation = await saveState(conversation_id, state);
      return turnPhaseComplete(
        { message: aiMessage, contact, conversation: finalConversation, turnResult: null },
        { branchTaken: 'quick_booking_entry' },
      );
    }
    stateMeta.reception_intake_phone_first = true;
    logPreLlmBookingFlow(
      env,
      'quick_booking_entry',
      'no_self_service_url_reception_intake',
      TurnEngineBranch.booking.quickEntryReception,
      'Quick booking entry without self-service URL; reception-style capture.',
    );
    const nextPromptNoUrl = getNextPromptForIntentFromState(state, 'appointment_request');
    const aiMessageNoUrl = nextPromptNoUrl?.prompt
      ? await insertMessage({
          conversation_id,
          role: 'ai',
          content: buildReceptionCapturePrompt(nextPromptNoUrl.field, nextPromptNoUrl.prompt),
          metadata: buildGuidedFieldMetadata(nextPromptNoUrl.field),
        })
      : await insertMessage({
          conversation_id,
          role: 'ai',
          content: 'Perfecto. Dime qué día y qué franja te viene mejor para registrarlo como solicitud.',
          metadata: { type: 'quick_booking_reception_entry' },
        });
    const finalConversationNoUrl = await saveState(conversation_id, state);
    return turnPhaseComplete(
      { message: aiMessageNoUrl, contact, conversation: finalConversationNoUrl, turnResult: null },
      { branchTaken: 'quick_booking_entry' },
    );
  }
  if ((routedContent === 'quick_path_direct' || bookingPathChoice === 'quick_path_direct') && !state.awaiting_confirmation) {
    stateMeta.booking_path_choice_open = false;
    const selfServiceUrl = process.env.BOOKING_SELF_SERVICE_URL?.trim() ?? '';
    if (selfServiceUrl) {
      logPreLlmBookingFlow(
        env,
        'quick_path_direct',
        'self_service_link_sent',
        TurnEngineBranch.booking.pathDirectLink,
        'Patient chose direct online booking; self-service link sent.',
      );
      const aiMessage = await insertMessage({
        conversation_id,
        role: 'ai',
        content: `Perfecto. Puedes elegir la hora directamente aquí:\n${selfServiceUrl}`,
        metadata: { type: 'quick_booking_direct_link' },
      });
      const finalConversation = await saveState(conversation_id, state);
      return turnPhaseComplete(
        { message: aiMessage, contact, conversation: finalConversation, turnResult: null },
        { branchTaken: 'quick_path_direct' },
      );
    }
    state.current_intent = 'appointment_request';
    state.completed = false;
    stateMeta.reception_intake_phone_first = true;
    const nextPrompt = getNextPromptForIntentFromState(state, 'appointment_request');
    if (nextPrompt?.prompt) {
      logPreLlmBookingFlow(
        env,
        'quick_path_direct',
        'no_url_fallback_reception_capture',
        TurnEngineBranch.booking.pathDirectReceptionPrompt,
        'Direct path chosen but no URL; fallback to reception capture prompt.',
      );
      const aiMessage = await insertMessage({
        conversation_id,
        role: 'ai',
        content: buildReceptionCapturePrompt(nextPrompt.field, nextPrompt.prompt),
        metadata: buildGuidedFieldMetadata(nextPrompt.field),
      });
      const finalConversation = await saveState(conversation_id, state);
      return turnPhaseComplete(
        { message: aiMessage, contact, conversation: finalConversation, turnResult: null },
        { branchTaken: 'quick_path_direct' },
      );
    }
  }
  if ((routedContent === 'quick_path_reception' || bookingPathChoice === 'quick_path_reception') && !state.awaiting_confirmation) {
    const pathChoiceWasOpen = stateMeta.booking_path_choice_open === true;
    stateMeta.booking_path_choice_open = false;
    state.current_intent = 'appointment_request';
    state.completed = false;
    stateMeta.reception_intake_phone_first = true;
    if (
      pathChoiceWasOpen &&
      (bookingPathChoice === 'quick_path_reception' || routedContent === 'quick_path_reception')
    ) {
      stateMeta.reception_phone_strict_gate = true;
    }
    const nextPrompt = getNextPromptForIntentFromState(state, 'appointment_request');
    if (nextPrompt?.prompt) {
      logPreLlmBookingFlow(
        env,
        'quick_path_reception',
        stateMeta.reception_phone_strict_gate === true ? 'strict_phone_gate_armed' : 'reception_capture_prompt',
        TurnEngineBranch.booking.pathReceptionPrompt,
        stateMeta.reception_phone_strict_gate === true
          ? 'Reception path with strict phone gate armed before further capture.'
          : 'Reception path; next capture prompt shown.',
      );
      const aiMessage = await insertMessage({
        conversation_id,
        role: 'ai',
        content: buildReceptionCapturePrompt(nextPrompt.field, nextPrompt.prompt),
        metadata: buildGuidedFieldMetadata(nextPrompt.field),
      });
      const finalConversation = await saveState(conversation_id, state);
      return turnPhaseComplete(
        { message: aiMessage, contact, conversation: finalConversation, turnResult: null },
        { branchTaken: 'quick_path_reception' },
      );
    }
  }

  if (stateMeta.asap_slot_choice_open === true) {
    const proposals = (stateMeta.asap_slot_proposals as AsapSlotProposal[]) ?? [];
    const idx = parseAsapSlotChoice(routedContent);
    if (idx !== null && proposals[idx]) {
      applyAsapSlotProposalToState(state, proposals[idx]);
      delete stateMeta.asap_slot_choice_open;
      delete stateMeta.asap_slot_proposals;
      state.booking = null;
      const chosen = proposals[idx];
      logPreLlmBookingFlow(
        env,
        'asap_slot_selected',
        chosen.id,
        TurnEngineBranch.booking.asapSlotSelected,
        `ASAP slot chosen (${chosen.id}).`,
      );
      await saveState(conversation_id, state);
      const aiMessage = await insertMessage({
        conversation_id,
        role: 'ai',
        content: `Perfecto, anoto ${chosen.displayLine}. Seguimos con tu solicitud.`,
        metadata: { type: 'asap_slot_selected', slot_id: chosen.id },
      });
      return turnPhaseComplete(
        {
          message: aiMessage,
          contact,
          conversation: await getConversationById(conversation_id),
          turnResult: null,
        },
        { branchTaken: 'asap_slot_selected' },
      );
    }
    logPreLlmBookingFlow(
      env,
      'asap_slot_invalid',
      'not_1_2_3',
      TurnEngineBranch.booking.asapSlotInvalid,
      'ASAP slot choice input did not match 1, 2, or 3.',
    );
    await saveState(conversation_id, state);
    const invalidAsap = await insertMessage({
      conversation_id,
      role: 'ai',
      content: ASAP_SLOT_INVALID_REPLY,
      metadata: { type: 'asap_slot_choice', retry: true },
    });
    return turnPhaseComplete(
      {
        message: invalidAsap,
        contact,
        conversation: await getConversationById(conversation_id),
        turnResult: null,
      },
      { branchTaken: 'asap_slot_invalid' },
    );
  }

  if (isReceptionPhoneStrictGateActive(state)) {
    if (!extractPhoneGuard(routedContent)) {
      logPreLlmBookingFlow(
        env,
        'reception_phone_gate_invalid',
        'not_valid_es_phone',
        TurnEngineBranch.booking.receptionPhoneRequired,
        'Strict reception gate: valid ES phone required before continuing.',
      );
      const gateMessage = await insertMessage({
        conversation_id,
        role: 'ai',
        content: RECEPTION_PHONE_GATE_INVALID_REPLY,
        metadata: { type: 'intake_guard', field: 'phone', gate: 'reception_path_strict' },
      });
      return turnPhaseComplete(
        {
          message: gateMessage,
          contact,
          conversation: await saveState(conversation_id, state),
          turnResult: null,
        },
        { branchTaken: 'reception_phone_gate_invalid' },
      );
    }
  }

  if (
    !isStrictBinaryFlowOpen(state) &&
    !isReceptionPhoneStrictGateActive(state) &&
    stateMeta.asap_slot_choice_open !== true
  ) {
    const schedulingIntent =
      state.current_intent === 'appointment_request' || state.current_intent === 'appointment_reschedule'
        ? state.current_intent
        : null;
    const nextPrompt = getNextPromptForIntentFromState(state, schedulingIntent);

    if (isSimpleGreetingOnly(routedContent) && !schedulingIntent) {
      logPreLlmSocial(
        env,
        TurnEngineBranch.booking.socialGreeting,
        'Simple greeting while no scheduling intent is active.',
      );
      const aiMessage = await insertMessage({
        conversation_id,
        role: 'ai',
        content: GREETING_CANONICAL_REPLY,
        metadata: { type: 'social_greeting' },
      });
      return turnPhaseComplete(
        { message: aiMessage, contact, conversation: await saveState(conversation_id, state), turnResult: null },
        { branchTaken: 'social_greeting' },
      );
    }

    if (isSimpleInfoIntent(routedContent) && !schedulingIntent) {
      logPreLlmSocial(
        env,
        TurnEngineBranch.booking.simpleInfo,
        'Simple info intent while no scheduling intent is active.',
      );
      const aiMessage = await insertMessage({
        conversation_id,
        role: 'ai',
        content: SIMPLE_INFO_INTENT_REPLY,
        metadata: { type: 'simple_info_intent' },
      });
      return turnPhaseComplete(
        { message: aiMessage, contact, conversation: await saveState(conversation_id, state), turnResult: null },
        { branchTaken: 'simple_info_intent' },
      );
    }

    if (isSimpleThanksOnly(routedContent)) {
      logPreLlmSocial(env, TurnEngineBranch.booking.socialThanks, 'simple_thanks');
      const aiMessage = await insertMessage({
        conversation_id,
        role: 'ai',
        content: nextPrompt?.prompt ? `¡De nada! ${nextPrompt.prompt}` : '¡De nada! Aquí estoy para ayudarte.',
        metadata: nextPrompt?.field ? buildGuidedFieldMetadata(nextPrompt.field) : { type: 'social_thanks' },
      });
      return turnPhaseComplete(
        { message: aiMessage, contact, conversation: await saveState(conversation_id, state), turnResult: null },
        { branchTaken: 'social_thanks' },
      );
    }

    if (isSimpleGoodbyeOnly(routedContent)) {
      logPreLlmSocial(env, TurnEngineBranch.booking.socialGoodbye, 'Simple goodbye.');
      const aiMessage = await insertMessage({
        conversation_id,
        role: 'ai',
        content: 'Perfecto, aquí me tienes cuando quieras. ¡Hasta luego!',
        metadata: { type: 'social_goodbye' },
      });
      return turnPhaseComplete(
        { message: aiMessage, contact, conversation: await saveState(conversation_id, state), turnResult: null },
        { branchTaken: 'social_goodbye' },
      );
    }

    if (isSimpleAckOnly(routedContent) && nextPrompt?.prompt) {
      logPreLlmSocial(env, TurnEngineBranch.booking.socialAck, 'Short ack with next guided prompt appended.');
      const aiMessage = await insertMessage({
        conversation_id,
        role: 'ai',
        content: `Perfecto. ${nextPrompt.prompt}`,
        metadata: buildGuidedFieldMetadata(nextPrompt.field),
      });
      return turnPhaseComplete(
        { message: aiMessage, contact, conversation: await saveState(conversation_id, state), turnResult: null },
        { branchTaken: 'social_ack' },
      );
    }
  }

  return turnPhaseNotHandled();
}

/** Reschedule list selection, post-completion email / no, offer decline, frustration, pre-LLM phone gate. */
export async function tryPostConfirmationBookingPhase(env: TurnPhaseEnv): Promise<TurnPhaseResult> {
  const { conversation_id, routedContent, patientMessage, state, stateMeta, refs } = env;
  const { contact, effectiveContactId } = refs;

  if (state.reschedule_phase === 'selecting_target') {
    const meta = state.metadata as Record<string, unknown>;
    const options = (meta.reschedule_options as Array<{ id: string; summary: string }>) ?? [];
    const optionsCount = (meta.reschedule_options_count as number) ?? options.length;
    const directSelected = options.find((opt) => opt.id === routedContent);
    if (directSelected) {
      state.reschedule_target_id = directSelected.id;
      state.reschedule_target_summary = directSelected.summary;
      state.reschedule_phase = 'collecting_new_details';
      resetAppointmentDraft(state);
      delete meta.reschedule_options;
      delete meta.reschedule_options_count;
      const nextPrompt = getNextPromptForIntentFromState(
        state,
        state.current_intent ?? 'appointment_reschedule',
      );
      const reply = `Perfecto, vamos a ajustar tu solicitud (${directSelected.summary}).\n\n${nextPrompt?.prompt ?? '¿Qué día te viene mejor?'}`;
      const aiMsg = await insertMessage({
        conversation_id,
        role: 'ai',
        content: reply,
        metadata: { type: 'reschedule_target_locked', target_id: directSelected.id },
      });
      logPostBookingBranch(
        env,
        TurnEngineBranch.booking.rescheduleTargetLockedDirect,
        'Reschedule target selected by option id.',
      );
      return turnPhaseComplete(
        { message: aiMsg, contact, conversation: await saveState(conversation_id, state), turnResult: null },
        { branchTaken: 'reschedule_target_locked' },
      );
    }
    const selection = classifyTargetSelection(routedContent, optionsCount);

    if (selection === 'abort') {
      state.reschedule_phase = 'idle';
      state.reschedule_target_id = null;
      state.reschedule_target_summary = null;
      delete meta.reschedule_options;
      delete meta.reschedule_options_count;
      const reply = 'Perfecto, dejamos las solicitudes como están. Si quieres, te ayudo a registrar una nueva.';
      const aiMsg = await insertMessage({
        conversation_id,
        role: 'ai',
        content: reply,
        metadata: { type: 'reschedule_aborted' },
      });
      logPostBookingBranch(env, TurnEngineBranch.booking.rescheduleAborted, 'Patient aborted reschedule selection.');
      return turnPhaseComplete(
        { message: aiMsg, contact, conversation: await saveState(conversation_id, state), turnResult: null },
        { branchTaken: 'reschedule_aborted' },
      );
    }

    if (selection === 'ambiguous') {
      const reply =
        'Perdona, no te he entendido bien 😊 Pulsa la solicitud que quieres cambiar o dime el número. Si prefieres dejarlo, escribe "cancelar".';
      const aiMsg = await insertMessage({
        conversation_id,
        role: 'ai',
        content: reply,
        metadata: { type: 'reschedule_selection_retry' },
      });
      logPostBookingBranch(
        env,
        TurnEngineBranch.booking.rescheduleSelectionRetry,
        'Reschedule list selection was ambiguous.',
      );
      return turnPhaseComplete(
        { message: aiMsg, contact, conversation: await saveState(conversation_id, state), turnResult: null },
        { branchTaken: 'reschedule_selection_retry' },
      );
    }

    const chosen = options[selection - 1];
    if (!chosen) {
      const reply = `Tienes ${options.length} solicitud(es) pendiente(s). Pulsa una opción o dime el número correcto. También puedes escribir "cancelar".`;
      const aiMsg = await insertMessage({
        conversation_id,
        role: 'ai',
        content: reply,
        metadata: { type: 'reschedule_selection_out_of_range' },
      });
      logPostBookingBranch(
        env,
        TurnEngineBranch.booking.rescheduleSelectionOutOfRange,
        'Numeric selection for reschedule was out of range.',
      );
      return turnPhaseComplete(
        { message: aiMsg, contact, conversation: await saveState(conversation_id, state), turnResult: null },
        { branchTaken: 'reschedule_selection_out_of_range' },
      );
    }

    state.reschedule_target_id = chosen.id;
    state.reschedule_target_summary = chosen.summary;
    state.reschedule_phase = 'collecting_new_details';
    resetAppointmentDraft(state);
    delete meta.reschedule_options;
    delete meta.reschedule_options_count;

    const nextPrompt = getNextPromptForIntentFromState(
      state,
      state.current_intent ?? 'appointment_reschedule',
    );
    const reply = `Perfecto, vamos a ajustar tu solicitud (${chosen.summary}).\n\n${nextPrompt?.prompt ?? '¿Qué día te viene mejor?'}`;
    const aiMsg = await insertMessage({
      conversation_id,
      role: 'ai',
      content: reply,
      metadata: { type: 'reschedule_target_locked', target_id: chosen.id },
    });
    logPostBookingBranch(
      env,
      TurnEngineBranch.booking.rescheduleTargetLockedNumeric,
      'Reschedule target selected by numeric index.',
    );
    return turnPhaseComplete(
      { message: aiMsg, contact, conversation: await saveState(conversation_id, state), turnResult: null },
      { branchTaken: 'reschedule_target_locked' },
    );
  }

  if (state.completed && state.appointment_request_open && !state.awaiting_confirmation) {
    const optionalEmailChoiceOpen = isOptionalEmailFollowupOpen(state);
    const optionalEmailChoice = parseStrictOneTwoChoice(routedContent);
    if (optionalEmailChoiceOpen && !optionalEmailChoice && routedContent !== 'email_add_yes' && routedContent !== 'email_add_no') {
      const aiMessage = await insertMessage({
        conversation_id,
        role: 'ai',
        content: OPTIONAL_EMAIL_STRICT_PROMPT,
        metadata: { type: 'optional_email_choice', options: EMAIL_FOLLOWUP_OPTIONS },
      });
      const finalConversation = await saveState(conversation_id, state);
      logPostBookingBranch(
        env,
        TurnEngineBranch.booking.postCompletionEmailStrict,
        'Optional email 1/2 gate: invalid choice.',
      );
      return turnPhaseComplete(
        { message: aiMessage, contact, conversation: finalConversation, turnResult: null },
        { branchTaken: 'post_completion_optional_email_strict' },
      );
    }
    if (routedContent === 'email_add_yes' || optionalEmailChoice === 1) {
      (state.metadata as Record<string, unknown>).optional_email_choice_open = false;
      const aiMessage = await insertMessage({
        conversation_id,
        role: 'ai',
        content: 'Perfecto. ¿A qué correo te envío el resumen?',
        metadata: { type: 'intake_guard', field: 'email_optional' },
      });
      const finalConversation = await saveState(conversation_id, state);
      logPostBookingBranch(env, TurnEngineBranch.booking.postCompletionEmailYes, 'Patient opted to add email.');
      return turnPhaseComplete(
        { message: aiMessage, contact, conversation: finalConversation, turnResult: null },
        { branchTaken: 'post_completion_email_add_yes' },
      );
    }
    if (routedContent === 'email_add_no' || optionalEmailChoice === 2) {
      (state.metadata as Record<string, unknown>).optional_email_choice_open = false;
      const selfServiceUrl = process.env.BOOKING_SELF_SERVICE_URL?.trim() ?? '';
      const closing = selfServiceUrl
        ? `Perfecto, seguimos sin correo. Tu solicitud ya está registrada y el equipo te confirmará disponibilidad en horario de atención. Si prefieres elegir hora directamente, aquí tienes el enlace: ${selfServiceUrl}`
        : 'Perfecto, seguimos sin correo. Tu solicitud ya está registrada y el equipo te confirmará disponibilidad en horario de atención.';
      const aiMessage = await insertMessage({
        conversation_id,
        role: 'ai',
        content: closing,
        metadata: { type: 'email_followup_skipped', path: 'post_completion_intercept' },
      });
      const finalConversation = await saveState(conversation_id, state);
      logPostBookingBranch(env, TurnEngineBranch.booking.postCompletionEmailNo, 'Patient skipped email follow-up.');
      return turnPhaseComplete(
        { message: aiMessage, contact, conversation: finalConversation, turnResult: null },
        { branchTaken: 'post_completion_email_add_no' },
      );
    }
    if (classifyConfirmation(routedContent) === 'no') {
      const correctionInvite = 'Perfecto. ¿Qué quieres cambiar: fecha, hora o servicio?';
      const aiMessage = await insertMessage({
        conversation_id,
        role: 'ai',
        content: correctionInvite,
        metadata: {
          type: 'correction_choice',
          path: 'post_completion_intercept',
          options: CORRECTION_CHOICE_OPTIONS,
        },
      });
      const finalConversation = await saveState(conversation_id, state);
      logPostBookingBranch(
        env,
        TurnEngineBranch.booking.postCompletionCorrection,
        'Post-completion flow: patient wants to change data.',
      );
      return turnPhaseComplete(
        { message: aiMessage, contact, conversation: finalConversation, turnResult: null },
        { branchTaken: 'post_completion_correction_invite' },
      );
    }
  }

  if (
    state.offer_appointment_pending &&
    !state.awaiting_confirmation &&
    isPlainDecline(routedContent) &&
    !isReceptionPhoneStrictGateActive(state) &&
    stateMeta.asap_slot_choice_open !== true
  ) {
    state.offer_appointment_pending = false;
    const aiMessage = await insertMessage({
      conversation_id,
      role: 'ai',
      content: DECLINE_OFFER_FOLLOWUP_REPLY_ES,
      metadata: { type: 'service_offer_declined', path: 'offer_pending_intercept' },
    });
    const finalConversation = await saveState(conversation_id, state);
    logPostBookingBranch(
      env,
      TurnEngineBranch.booking.offerDeclined,
      'Plain decline while appointment offer was pending.',
    );
    return turnPhaseComplete(
      { message: aiMessage, contact, conversation: finalConversation, turnResult: null },
      { branchTaken: 'offer_pending_declined' },
    );
  }

  if (
    !state.escalated &&
    isFrustrationSignal(routedContent) &&
    !isReceptionPhoneStrictGateActive(state) &&
    stateMeta.asap_slot_choice_open !== true
  ) {
    state.escalated = true;
    state.escalation_reason = 'Deterministic frustration signal detected.';
    await createHandoff({
      conversationId: conversation_id,
      contactId: effectiveContactId,
      escalation: { shouldEscalate: true, reason: state.escalation_reason, type: 'human' },
      triggerMessageId: patientMessage.id,
    });
    log('info', 'event.handoff_created', {
      conversation_id,
      contact_id: effectiveContactId,
      path: 'frustration_intercept',
    });
    logPostBookingBranch(
      env,
      TurnEngineBranch.booking.frustrationHandoff,
      'Deterministic frustration signal; handoff created.',
    );
    const aiMessage = await insertMessage({
      conversation_id,
      role: 'ai',
      content: FRUSTRATION_ESCALATION_REPLY_ES,
      metadata: { type: 'frustration_escalated', path: 'frustration_intercept' },
    });
    const finalConversation = await saveState(conversation_id, state);
    return turnPhaseComplete(
      { message: aiMessage, contact, conversation: finalConversation, turnResult: null },
      { branchTaken: 'frustration_intercept' },
    );
  }

  if (isReceptionPhoneStrictGateActive(state)) {
    const gateFallback = await insertMessage({
      conversation_id,
      role: 'ai',
      content: RECEPTION_PHONE_GATE_INVALID_REPLY,
      metadata: { type: 'intake_guard', field: 'phone', gate: 'reception_path_strict_pre_llm' },
    });
    logPostBookingBranch(
      env,
      TurnEngineBranch.booking.receptionGateFallback,
      'Strict reception phone gate still active post-phases; invalid input.',
    );
    return turnPhaseComplete(
      {
        message: gateFallback,
        contact,
        conversation: await saveState(conversation_id, state),
        turnResult: null,
      },
      { branchTaken: 'reception_path_strict_pre_llm' },
    );
  }

  return turnPhaseNotHandled();
}
