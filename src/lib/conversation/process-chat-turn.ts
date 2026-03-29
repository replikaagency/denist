import {
  clearReceptionPhoneStrictGateIfPhoneSatisfied,
  getPriorPatientMessageTexts,
} from '@/lib/conversation/intake.service';
import { tryDeterministicIntakeCapture } from '@/lib/conversation/intake-capture';
import {
  hydrateStatePatientFromContact,
} from '@/lib/conversation/intake-guards';
import { getNextStep } from '@/lib/conversation/flow-rules';
import { loadState, saveState } from '@/services/conversation.service';
import { findOpenAppointmentRequest } from '@/services/appointment.service';
import { getActiveHybridBookingForConversation } from '@/lib/db/hybrid-bookings';
import { insertMessage } from '@/lib/db/messages';
import { log } from '@/lib/logger';
import { TurnEngineBranch } from '@/lib/conversation/turn-engine-branches';
import type { TurnEngineBranchId } from '@/lib/conversation/turn-engine-branches';
import { logTurnEngineBranch } from '@/lib/conversation/turn-engine-log';
import { getConversationById } from '@/services/conversation.service';
import {
  ENTRY_REPLY_BOOKING,
  ENTRY_REPLY_URGENCY,
  ENTRY_REPLY_TREATMENT_INFO,
  ENTRY_REPLY_RESCHEDULE,
  ENTRY_BOOKING_PATIENT_STATUS_OPTIONS,
} from '@/lib/conversation/response-builder';
import { handleBookingEntryGate } from '@/lib/conversation/entry-booking-gate';
import type { ChatTurnResult, ExecuteProcessChatTurnInput } from '@/lib/conversation/chat-turn-types';
import type { ConversationState } from '@/lib/conversation/schema';
import {
  takeCompletedTurnResult,
  type TurnPhaseEnv,
  type TurnPhaseRefs,
} from '@/lib/conversation/turn-phases/types';
import { tryConfirmationPhase } from '@/lib/conversation/turn-phases/handle-confirmation-phase';
import {
  tryPostConfirmationBookingPhase,
  tryPreLlmBookingPhase,
} from '@/lib/conversation/turn-phases/handle-booking-phase';
import { runLlmPhase } from '@/lib/conversation/turn-phases/handle-llm-phase';
import { runSideEffectsPhase } from '@/lib/conversation/turn-phases/handle-side-effects-phase';

function logCoordinatorYield(
  conversation_id: string,
  routedContent: string,
  state: ConversationState,
  branchTaken: TurnEngineBranchId,
  reason: string,
): void {
  logTurnEngineBranch({
    conversationId: conversation_id,
    branchTaken,
    reason,
    inputSummary: routedContent,
    state,
  });
}

/** Core turn: load state → phase pipeline → final result (patient message already saved). */
export async function executeProcessChatTurn(
  input: ExecuteProcessChatTurnInput,
): Promise<ChatTurnResult> {
  const {
    conversation_id,
    content,
    routedContent,
    patientMessage,
    conversation: conv0,
    contact: contact0,
  } = input;

  const refs: TurnPhaseRefs = {
    conversation: conv0,
    contact: contact0,
    effectiveContactId: conv0.contact_id,
  };

  const state = await loadState(conversation_id);
  hydrateStatePatientFromContact(state, refs.contact, { includeEmail: true });
  const stateMeta = state.metadata as Record<string, unknown>;

  // --- ENTRY DETECTION LAYER ---
  if (!stateMeta.entry_detected_at) {
    const priorTexts = await getPriorPatientMessageTexts(conversation_id);
    const isFirstMessage = priorTexts.length <= 1;

    if (isFirstMessage) {
      const msgMeta = (patientMessage?.metadata || {}) as Record<string, unknown>;
      let detectedIntent: string | null = null;

      if (msgMeta.prefilled || msgMeta.entry_intent) {
        detectedIntent = (msgMeta.entry_intent as string) || 'general_question';
      } else {
        const text = content.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        if (text.includes('quiero pedir una cita') || text.includes('agendar cita') || text.includes('pedir cita')) {
          detectedIntent = 'booking_request';
        } else if (text.includes('urgencia dental') || text.includes('urgente') || text.includes('tengo una urgencia')) {
          detectedIntent = 'urgency';
        } else if (text.includes('cambiar mi cita') || text.includes('reprogramar') || text.includes('cambiar cita')) {
          detectedIntent = 'reschedule';
        } else if (text.includes('informacion sobre') || text.includes('quiero informacion')) {
          detectedIntent = 'treatment_info';
        }
      }

      if (detectedIntent) {
        stateMeta.entry_intent = detectedIntent;
        stateMeta.entry_source = msgMeta.entry_source || 'text_fallback';
        stateMeta.entry_detected_at = new Date().toISOString();

        if (detectedIntent === 'booking_request') state.current_intent = 'appointment_request';
        else if (detectedIntent === 'urgency') state.current_intent = 'emergency_report';
        else if (detectedIntent === 'reschedule') state.current_intent = 'appointment_reschedule';
        else if (detectedIntent === 'treatment_info') state.current_intent = 'service_inquiry';

        // For booking: open the strict binary patient-status gate
        if (detectedIntent === 'booking_request') {
          stateMeta.booking_patient_status_pending = true;
        }
        
        let replyText = '';
        let replyMetadata: Record<string, unknown> = { type: 'prefilled_entry_reply', intent: detectedIntent };
        if (detectedIntent === 'booking_request') {
          replyText = ENTRY_REPLY_BOOKING;
          replyMetadata = {
            type: 'patient_status_choice',
            field: 'new_or_returning',
            intent: detectedIntent,
            options: ENTRY_BOOKING_PATIENT_STATUS_OPTIONS,
          };
        } else if (detectedIntent === 'urgency') replyText = ENTRY_REPLY_URGENCY;
        else if (detectedIntent === 'treatment_info') replyText = ENTRY_REPLY_TREATMENT_INFO;
        else if (detectedIntent === 'reschedule') replyText = ENTRY_REPLY_RESCHEDULE;
        
        if (replyText) {
          await saveState(conversation_id, state);
          const aiMessage = await insertMessage({
            conversation_id,
            role: 'ai',
            content: replyText,
            metadata: replyMetadata,
          });
          
          logTurnEngineBranch({
            conversationId: conversation_id,
            branchTaken: TurnEngineBranch.coordinator.pipelineStart,
            reason: `Fast-path entry routing for intent: ${detectedIntent}`,
            inputSummary: content,
            state,
          });

          return {
            message: aiMessage,
            contact: refs.contact,
            conversation: await getConversationById(conversation_id),
            turnResult: null,
          };
        }
      } else {
        // Mark as evaluated to lock detection
        stateMeta.entry_detected_at = new Date().toISOString();
        stateMeta.entry_source = 'none';
      }
    } else {
      stateMeta.entry_detected_at = new Date().toISOString();
      stateMeta.entry_source = 'none';
    }
  }
  // --- END ENTRY DETECTION LAYER ---

  // --- BOOKING ENTRY GATE (strict binary patient status) ---
  // Must run BEFORE awaiting_confirmation and before DB sync.
  // Only active when booking_patient_status_pending was set by entry detection.
  {
    const gateResult = await handleBookingEntryGate({
      conversation_id,
      routedContent,
      state,
      contact: refs.contact,
    });
    if (gateResult.handled) return gateResult.result;
  }
  // --- END BOOKING ENTRY GATE ---

  const preExistingRequest = await findOpenAppointmentRequest(conversation_id);
  state.appointment_request_open = !!preExistingRequest;

  let preExistingHybrid: Awaited<ReturnType<typeof getActiveHybridBookingForConversation>> = null;
  try {
    preExistingHybrid = await getActiveHybridBookingForConversation(conversation_id);
  } catch (err) {
    log('error', 'hybrid_booking.fetch_failed', {
      conversation_id,
      phase: 'pre_turn_sync',
      error: err instanceof Error ? err.message : String(err),
    });
    preExistingHybrid = null;
  }
  state.hybrid_booking_open = !!preExistingHybrid;

  if (!preExistingRequest && state.completed) {
    state.completed = false;
  }

  clearReceptionPhoneStrictGateIfPhoneSatisfied(state);

  getNextStep(state, routedContent, { conversation_id });

  const env: TurnPhaseEnv = {
    conversation_id,
    content,
    routedContent,
    patientMessage,
    state,
    stateMeta,
    refs,
    preExistingRequest,
  };

  // Hard gate: when confirmation is open, process it before any other phase so
  // no booking path can bypass explicit patient confirmation.
  if (state.awaiting_confirmation) {
    if (!state.pending_appointment) {
      state.pending_appointment = { ...state.appointment };
      log('warn', 'confirmation.pending_appointment_missing_recovered', {
        conversation_id,
      });
    }
    const confirmationFirst = await tryConfirmationPhase(env);
    const confirmationFirstDone = takeCompletedTurnResult(confirmationFirst);
    if (confirmationFirstDone) return confirmationFirstDone;
  }

  logTurnEngineBranch({
    conversationId: conversation_id,
    branchTaken: TurnEngineBranch.coordinator.pipelineStart,
    reason: 'State hydrated; open request and hybrid flags synced.',
    inputSummary: routedContent,
    state,
  });

  const preBooking = await tryPreLlmBookingPhase(env);
  const preDone = takeCompletedTurnResult(preBooking);
  if (preDone) return preDone;
  if (!preBooking.handled) {
    logCoordinatorYield(
      conversation_id,
      routedContent,
      state,
      TurnEngineBranch.coordinator.yieldIntake,
      'Pre-LLM booking phase did not handle the turn; continuing to deterministic intake.',
    );
  }

  const priorPatientTexts = await getPriorPatientMessageTexts(conversation_id);
  const intakeResult = await tryDeterministicIntakeCapture({
    state,
    content: routedContent,
    conversation_id,
    contact: refs.contact,
    getConversationById,
    priorPatientTexts,
  });
  if (intakeResult) return intakeResult;

  logCoordinatorYield(
    conversation_id,
    routedContent,
    state,
    TurnEngineBranch.coordinator.deterministicIntake,
    'yield_confirmation_phase',
  );

  const confirmation = await tryConfirmationPhase(env);
  const confirmationDone = takeCompletedTurnResult(confirmation);
  if (confirmationDone) return confirmationDone;
  if (!confirmation.handled) {
    logCoordinatorYield(
      conversation_id,
      routedContent,
      state,
      TurnEngineBranch.coordinator.yieldPostBooking,
      'Confirmation phase did not handle the turn; continuing to post-confirmation booking phase.',
    );
  }

  const postBooking = await tryPostConfirmationBookingPhase(env);
  const postDone = takeCompletedTurnResult(postBooking);
  if (postDone) return postDone;
  if (!postBooking.handled) {
    logCoordinatorYield(
      conversation_id,
      routedContent,
      state,
      TurnEngineBranch.coordinator.yieldLlm,
      'Post-confirmation booking phase did not handle the turn; continuing to LLM phase.',
    );
  }

  const llmPhase = await runLlmPhase(env);
  const llmDone = takeCompletedTurnResult(llmPhase);
  if (llmDone) return llmDone;
  if (llmPhase.llmContinue) {
    const side = await runSideEffectsPhase(
      env,
      llmPhase.llmContinue.turnResult,
      llmPhase.llmContinue.llmResult,
    );
    return takeCompletedTurnResult(side)!;
  }

  throw new Error('turn_engine_invariant: LLM phase neither completed nor continued');
}
