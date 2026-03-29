import { insertMessage } from '@/lib/db/messages';
import { updateConversation } from '@/lib/db/conversations';
import {
  classifyConfirmation,
  detectCorrectionSignals,
} from '@/lib/conversation/confirmation';
import {
  CONFIRMATION_CHANGE_ROUTING_REPLY,
  CONFIRMATION_CLARIFY_HARD_GATE_REPLY,
  CORRECTION_CHOICE_OPTIONS,
  EMAIL_FOLLOWUP_OPTIONS,
  OPTIONAL_EMAIL_STRICT_PROMPT,
} from '@/lib/conversation/response-builder';
import { AppError } from '@/lib/errors';
import { log } from '@/lib/logger';
import { saveState } from '@/services/conversation.service';
import { ensureLead } from '@/services/lead.service';
import {
  getOpenAppointmentRequestForConversation,
  updateAppointmentRequest,
} from '@/lib/db/appointments';
import {
  createRequest,
  executeReschedule,
  isAppointmentDataComplete,
} from '@/services/appointment.service';
import { createHandoff } from '@/services/handoff.service';
import {
  turnPhaseComplete,
  turnPhaseNotHandled,
  type TurnPhaseEnv,
  type TurnPhaseResult,
} from '@/lib/conversation/turn-phases/types';
import { TurnEngineBranch } from '@/lib/conversation/turn-engine-branches';
import type { TurnEngineBranchId } from '@/lib/conversation/turn-engine-branches';
import { logTurnEngineBranch } from '@/lib/conversation/turn-engine-log';

const CONFIRMATION_PROMPT_TTL_MS = 30 * 60 * 1000;

function normalizeForConfirmationSignals(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function hasExplicitConfirmToken(text: string): boolean {
  const t = normalizeForConfirmationSignals(text);
  return /\b(confirmo|confirmar|confirmado|confirmada|si|sii+|ok|vale|listo|confirm_yes)\b/.test(t);
}

function hasMixedExtraIntent(text: string): boolean {
  const t = normalizeForConfirmationSignals(text);
  return /\b(pero|ademas|tambien|otra cita|preguntar|tengo dolor|antes queria)\b/.test(t);
}

function hasUnrelatedSideIntent(text: string): boolean {
  const t = normalizeForConfirmationSignals(text);
  return /\b(precio|seguro|dolor|urgencia|horario|direccion|otra cita|preguntar)\b/.test(t);
}

function logConfirmationPhaseBranch(env: TurnPhaseEnv, branchTaken: TurnEngineBranchId, reason: string): void {
  logTurnEngineBranch({
    conversationId: env.conversation_id,
    branchTaken,
    reason,
    inputSummary: env.routedContent,
    state: env.state,
  });
}

/**
 * Explicit confirmation intercept (bypasses LLM).
 */
export async function tryConfirmationPhase(env: TurnPhaseEnv): Promise<TurnPhaseResult> {
  const { conversation_id, content, routedContent, patientMessage, state, refs } = env;
  const { contact, effectiveContactId } = refs;

  if (!state.awaiting_confirmation || !state.pending_appointment) {
    return turnPhaseNotHandled();
  }

  try {
    if (!state.confirmation_prompt_at) {
      state.confirmation_prompt_at = new Date().toISOString();
    }

    let confirmationExpired = false;
    if (state.confirmation_prompt_at) {
      const promptMs = new Date(state.confirmation_prompt_at).getTime();
      if (!Number.isNaN(promptMs) && Date.now() - promptMs > CONFIRMATION_PROMPT_TTL_MS) {
        confirmationExpired = true;
      }
    }

    if (confirmationExpired) {
      state.awaiting_confirmation = false;
      state.pending_appointment = null;
      state.confirmation_attempts = 0;
      state.confirmation_prompt_at = null;
      state.reschedule_phase = 'idle';
      state.reschedule_target_id = null;
      state.reschedule_target_summary = null;
      refs.conversation = await saveState(conversation_id, state);
      logConfirmationPhaseBranch(
        env,
        TurnEngineBranch.confirmation.ttlExpired,
        'Confirmation prompt exceeded TTL; state reset.',
      );
      const expiryMessage = await insertMessage({
        conversation_id,
        role: 'ai',
        content: 'La solicitud anterior ha caducado por inactividad.\n\nSi quieres, seguimos de nuevo.',
        metadata: { type: 'confirmation_ttl_expired', path: 'confirmation_intercept' },
      });
      return turnPhaseComplete(
        { message: expiryMessage, contact, conversation: refs.conversation, turnResult: null },
        { branchTaken: TurnEngineBranch.confirmation.ttlExpired },
      );
    } else {
      const pendingAppointment = state.pending_appointment;
      if (content === 'confirm_yes' || content === 'confirm_change') {
        log('info', 'chat.confirmation_button_input', {
          conversation_id,
          input: content,
        });
      }
      if (hasExplicitConfirmToken(routedContent) && hasMixedExtraIntent(routedContent)) {
        logConfirmationPhaseBranch(
          env,
          TurnEngineBranch.confirmation.mixedIntentDetected,
          'Explicit confirmation token mixed with extra intent in same patient message.',
        );
      }
      const requestedChange = content === 'confirm_change' || detectCorrectionSignals(routedContent);
      if (requestedChange) {
        logConfirmationPhaseBranch(
          env,
          TurnEngineBranch.confirmation.changeIntentDetected,
          'Change-details intent detected while awaiting confirmation.',
        );
        const wasReschedule = !!state.reschedule_target_id;
        state.awaiting_confirmation = false;
        state.pending_appointment = null;
        state.confirmation_attempts = 0;
        state.confirmation_prompt_at = null;
        if (wasReschedule) {
          state.reschedule_phase = 'idle';
          state.reschedule_target_id = null;
          state.reschedule_target_summary = null;
        }
        const aiMessage = await insertMessage({
          conversation_id,
          role: 'ai',
          content: CONFIRMATION_CHANGE_ROUTING_REPLY,
          metadata: {
            type: 'correction_choice',
            decline_type: wasReschedule ? 'reschedule_declined' : 'appointment_declined',
            classifier_result: 'change_request',
            path: 'confirmation_intercept',
            options: CORRECTION_CHOICE_OPTIONS,
          },
        });
        const finalConversation = await saveState(conversation_id, state);
        logConfirmationPhaseBranch(
          env,
          wasReschedule
            ? TurnEngineBranch.confirmation.declinedReschedule
            : TurnEngineBranch.confirmation.declinedNew,
          'Patient requested changes while awaiting confirmation; routed directly to change flow.',
        );
        return turnPhaseComplete(
          { message: aiMessage, contact, conversation: finalConversation, turnResult: null },
          { branchTaken: wasReschedule ? 'confirmation_no_reschedule' : 'confirmation_no_new_booking' },
        );
      }
      let confirmation = classifyConfirmation(routedContent);
      if (confirmation === 'yes' && !isAppointmentDataComplete(pendingAppointment)) {
        confirmation = 'ambiguous';
      }
      if (confirmation === 'ambiguous') {
        logConfirmationPhaseBranch(
          env,
          TurnEngineBranch.confirmation.ambiguousDetected,
          'Ambiguous confirmation classification while confirmation gate is active.',
        );
        if (hasUnrelatedSideIntent(routedContent)) {
          logConfirmationPhaseBranch(
            env,
            TurnEngineBranch.confirmation.unrelatedIntentBlocked,
            'Unrelated intent intentionally blocked until confirmation resolves.',
          );
        }
      }
      const canPersistBooking =
        confirmation === 'yes' &&
        isAppointmentDataComplete(pendingAppointment) &&
        !detectCorrectionSignals(routedContent);
      log('info', 'chat.confirmation_classified', {
        conversation_id,
        result: confirmation,
        canPersistBooking,
      });

      if (canPersistBooking) {
        try {
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
              const rescheduled = await executeReschedule({
                oldRequestId: state.reschedule_target_id!,
                contactId: effectiveContactId,
                conversationId: conversation_id,
                leadId: localLead.id,
                appointment: pendingAppointment,
              });
              await updateAppointmentRequest(rescheduled.id, {
                status: 'confirmed',
                confirmed_datetime: new Date().toISOString(),
              });
              confirmReply =
                'Perfecto, tu solicitud de cambio queda registrada.\nRecepción la revisará y te contactará para confirmar la nueva cita.\nSi te duele mucho, escribe "urgente".\n\n' +
                OPTIONAL_EMAIL_STRICT_PROMPT;
            } catch (err: unknown) {
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
                'Perfecto, tu solicitud queda registrada.\nRecepción la revisará y te contactará para confirmar la cita.\nSi te duele mucho, escribe "urgente".\n\n' +
                OPTIONAL_EMAIL_STRICT_PROMPT;
            }
          } else {
            log('info', 'event.appointment_request_created', {
              conversation_id,
              contact_id: effectiveContactId,
              path: 'confirmation_intercept',
            });
            const createdRequest = await createRequest({
              contactId: effectiveContactId,
              conversationId: conversation_id,
              leadId: localLead.id,
              appointment: pendingAppointment,
            });
            await updateAppointmentRequest(createdRequest.id, {
              status: 'confirmed',
              confirmed_datetime: new Date().toISOString(),
            });
            confirmReply =
              'Perfecto, solicitud registrada.\nRecepción la revisará y te contactará para confirmar la cita.\nSi te duele mucho, escribe "urgente".\n\n' +
              OPTIONAL_EMAIL_STRICT_PROMPT;
          }

          state.awaiting_confirmation = false;
          state.pending_appointment = null;
          state.confirmation_attempts = 0;
          state.confirmation_prompt_at = null;
          state.appointment_request_open = true;
          state.completed = true;
          state.reschedule_phase = 'idle';
          state.reschedule_target_id = null;
          state.reschedule_target_summary = null;
          (state.metadata as Record<string, unknown>).optional_email_choice_open = true;

          const aiMessage = await insertMessage({
            conversation_id,
            role: 'ai',
            content: confirmReply,
            metadata: {
              type: 'optional_email_choice',
              classifier_result: 'yes',
              path: 'confirmation_intercept',
              options: EMAIL_FOLLOWUP_OPTIONS,
            },
          });
          const finalConversation = await saveState(conversation_id, state);
          log('info', 'chat.confirmation_success', {
            conversation_id,
            is_reschedule: isReschedule,
            awaiting_confirmation: state.awaiting_confirmation,
            appointment_request_open: state.appointment_request_open,
            completed: state.completed,
          });
          logConfirmationPhaseBranch(
            env,
            TurnEngineBranch.confirmation.persistedYes,
            isReschedule
              ? 'Patient confirmed; reschedule path persisted request.'
              : 'Patient confirmed; new appointment request persisted.',
          );
          return turnPhaseComplete(
            { message: aiMessage, contact, conversation: finalConversation, turnResult: null },
            { branchTaken: 'confirmation_success' },
          );
        } catch (err) {
          log('error', 'chat.confirmation_success_path_failed', {
            conversation_id,
            error: err instanceof Error ? err.message : err,
          });
          const fallbackMessage = await insertMessage({
            conversation_id,
            role: 'ai',
            content:
              'No he podido cerrar la confirmación ahora mismo.\n¿Quieres que lo intentemos de nuevo o te paso con recepción?',
            metadata: { type: 'confirmation_persist_fallback', path: 'confirmation_intercept' },
          });
          logConfirmationPhaseBranch(
            env,
            TurnEngineBranch.confirmation.persistFailed,
            'Lead or DB persist failed after classifier yes.',
          );
          return turnPhaseComplete(
            { message: fallbackMessage, contact, conversation: refs.conversation, turnResult: null },
            { branchTaken: 'confirmation_persist_fallback' },
          );
        }
      }

      if (confirmation === 'no') {
        const wasReschedule = !!state.reschedule_target_id;
        const openRequest = await getOpenAppointmentRequestForConversation(conversation_id);
        if (openRequest && openRequest.status === 'pending') {
          await updateAppointmentRequest(openRequest.id, { status: 'cancelled' });
        }
        state.awaiting_confirmation = false;
        state.pending_appointment = null;
        state.confirmation_attempts = 0;
        state.confirmation_prompt_at = null;
        state.reschedule_phase = 'idle';
        state.reschedule_target_id = null;
        state.reschedule_target_summary = null;
        const declineReply = wasReschedule
          ? 'Perfecto, dejamos la solicitud actual como está.\nSi quieres, te ayudo a crear una nueva preferencia.\nSi te duele mucho, escribe "urgente".'
          : 'Perfecto, no la confirmamos aún.\n¿Qué quieres cambiar: fecha, hora o servicio?\nSi te duele mucho, escribe "urgente".';
        const aiMessage = await insertMessage({
          conversation_id,
          role: 'ai',
          content: declineReply,
          metadata: {
            type: 'correction_choice',
            decline_type: wasReschedule ? 'reschedule_declined' : 'appointment_declined',
            classifier_result: 'no',
            path: 'confirmation_intercept',
            options: CORRECTION_CHOICE_OPTIONS,
          },
        });
        const finalConversation = await saveState(conversation_id, state);
        logConfirmationPhaseBranch(
          env,
          wasReschedule
            ? TurnEngineBranch.confirmation.declinedReschedule
            : TurnEngineBranch.confirmation.declinedNew,
          'Classifier returned no; offering correction or closing reschedule path.',
        );
        return turnPhaseComplete(
          { message: aiMessage, contact, conversation: finalConversation, turnResult: null },
          { branchTaken: wasReschedule ? 'confirmation_no_reschedule' : 'confirmation_no_new_booking' },
        );
      }

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
        logConfirmationPhaseBranch(
          env,
          TurnEngineBranch.confirmation.escalatedAmbiguous,
          'Too many ambiguous replies; handoff to human.',
        );
        const escalateReply =
          'No me queda claro si quieres confirmar o cambiar.\nTe paso con recepción para ayudarte ahora mismo.';
        const aiMessage = await insertMessage({
          conversation_id,
          role: 'ai',
          content: escalateReply,
          metadata: { type: 'confirmation_escalated', classifier_result: 'ambiguous', path: 'confirmation_intercept' },
        });
        const finalConversation = await saveState(conversation_id, state);
        return turnPhaseComplete(
          { message: aiMessage, contact, conversation: finalConversation, turnResult: null },
          { branchTaken: 'confirmation_escalated' },
        );
      }

      const clarifyReply =
        CONFIRMATION_CLARIFY_HARD_GATE_REPLY;
      const aiMessage = await insertMessage({
        conversation_id,
        role: 'ai',
        content: clarifyReply,
        metadata: {
          type: 'awaiting_confirmation',
          attempts,
          classifier_result: 'ambiguous',
          path: 'confirmation_intercept',
          options: [
            { label: 'Confirmar', value: 'confirm_yes' },
            { label: 'Cambiar datos', value: 'confirm_change' },
          ],
        },
      });
      const finalConversation = await saveState(conversation_id, state);
      logConfirmationPhaseBranch(
        env,
        TurnEngineBranch.confirmation.clarify,
        'Classifier ambiguous; asking patient to confirm or change.',
      );
      return turnPhaseComplete(
        { message: aiMessage, contact, conversation: finalConversation, turnResult: null },
        { branchTaken: 'confirmation_clarify_ambiguous' },
      );
    }
  } catch (err) {
    log('error', 'chat.confirmation_intercept_failed', {
      conversation_id,
      error: err instanceof Error ? err.message : err,
    });
    try {
      const fallbackMessage = await insertMessage({
        conversation_id,
        role: 'ai',
        content:
          'No he podido cerrar la confirmación ahora mismo.\n¿Quieres que lo intentemos de nuevo o te paso con recepción?',
        metadata: { type: 'confirmation_intercept_fallback', path: 'confirmation_intercept' },
      });
      logConfirmationPhaseBranch(
        env,
        TurnEngineBranch.confirmation.interceptFallback,
        'Confirmation intercept threw; fallback AI message sent.',
      );
      return turnPhaseComplete(
        { message: fallbackMessage, contact, conversation: refs.conversation, turnResult: null },
        { branchTaken: 'confirmation_intercept_fallback' },
      );
    } catch {
      throw AppError.conflict(
        'No he podido completar la confirmación ahora mismo. Inténtalo de nuevo en unos segundos.',
      );
    }
  }

  return turnPhaseNotHandled();
}
