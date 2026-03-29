import { getRecentMessages, insertMessage } from '@/lib/db/messages';
import { callLLM } from '@/lib/ai/completion';
import { buildSystemPrompt, getClinicConfig, FEW_SHOT_BY_INTENT } from '@/lib/conversation/prompts';
import { getMissingFields, fieldQueryOptionsFromState } from '@/lib/conversation/fields';
import { getNextStep } from '@/lib/conversation/flow-rules';
import { processTurn } from '@/lib/conversation/engine';
import { tryBuildSyntheticNegationSchedulingCorrectionJson } from '@/lib/conversation/scheduling-negation-correction';
import { LIMITS } from '@/config/constants';
import { log } from '@/lib/logger';
import {
  BOOKING_PATH_STRICT_PROMPT,
  GREETING_CANONICAL_REPLY,
  QUICK_BOOKING_PATH_OPTIONS,
  SIMPLE_INFO_INTENT_REPLY,
  buildBookingSideQuestionFollowup,
  isSimpleGreetingOnly,
  isSimpleInfoIntent,
} from '@/lib/conversation/response-builder';
import { getPriorPatientMessageTexts } from '@/lib/conversation/intake.service';
import { buildLLMMessages, getNextPromptForIntentFromState } from '@/lib/conversation/booking.service';
import { tryDeterministicIntakeCapture } from '@/lib/conversation/intake-capture';
import { getConversationById, saveState } from '@/services/conversation.service';
import {
  turnPhaseComplete,
  turnPhaseContinueWithLlm,
  type TurnPhaseEnv,
  type TurnPhaseResult,
} from '@/lib/conversation/turn-phases/types';
import type { ConversationState } from '@/lib/conversation/schema';
import { TurnEngineBranch } from '@/lib/conversation/turn-engine-branches';
import type { TurnEngineBranchId } from '@/lib/conversation/turn-engine-branches';
import { logTurnEngineBranch } from '@/lib/conversation/turn-engine-log';

function logLlmPhaseBranch(
  env: TurnPhaseEnv,
  branchTaken: TurnEngineBranchId,
  reason: string,
  stateForFlow: ConversationState = env.state,
): void {
  logTurnEngineBranch({
    conversationId: env.conversation_id,
    branchTaken,
    reason,
    inputSummary: env.routedContent,
    state: stateForFlow,
  });
}

/**
 * Build prompt, call LLM, run engine, parse recovery, reply polish + logs.
 */
export async function runLlmPhase(env: TurnPhaseEnv): Promise<TurnPhaseResult> {
  const { conversation_id, routedContent, state, stateMeta, refs } = env;
  const { contact } = refs;

  const systemPrompt = buildSystemPrompt(getClinicConfig(), state);

  const history = await getRecentMessages(conversation_id, LIMITS.CONTEXT_WINDOW);
  const llmMessages = buildLLMMessages(history);

  if (state.current_intent) {
    const isSchedulingIntent =
      state.current_intent === 'appointment_request' || state.current_intent === 'appointment_reschedule';
    const filledFields = {
      patient: state.patient,
      appointment: state.appointment,
      symptoms: state.symptoms,
    };
    const missing = getMissingFields(state.current_intent, filledFields, fieldQueryOptionsFromState(state));
    const useCompletionExample =
      isSchedulingIntent && missing.length === 0 && !state.completed && !state.appointment_request_open;

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

  const preLlmFlow = getNextStep(state, routedContent, { conversation_id });
  if (!preLlmFlow.allowLLM) {
    log('warn', 'chat.flow_llm_invariant', {
      conversation_id,
      step: preLlmFlow.step,
      reason: preLlmFlow.reason,
    });
  }

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
      content: `Disculpa, hemos tenido un problema técnico. Puedes contactar directamente con la clínica en el ${clinicPhone}.`,
      metadata: { type: 'llm_error_fallback' },
    });
    logLlmPhaseBranch(env, TurnEngineBranch.llm.callFailed, 'callLLM threw; technical fallback reply.');
    return turnPhaseComplete(
      { message: fallbackMessage, contact, conversation: refs.conversation, turnResult: null },
      { branchTaken: 'llm_call_failed' },
    );
  }

  let turnResult = processTurn(llmResult.text, state, routedContent);

  if ('error' in turnResult) {
    const syntheticJson = tryBuildSyntheticNegationSchedulingCorrectionJson(routedContent, state);
    if (syntheticJson) {
      log('info', 'chat.synthetic_negation_scheduling_correction', { conversation_id });
      turnResult = processTurn(syntheticJson, state, routedContent);
    }
  }

  if ('error' in turnResult) {
    log('error', 'chat.llm_parse_failure', {
      conversation_id,
      error: turnResult.error,
    });
    if (isSimpleGreetingOnly(routedContent)) {
      const greetingMessage = await insertMessage({
        conversation_id,
        role: 'ai',
        content: GREETING_CANONICAL_REPLY,
        metadata: { type: 'social_greeting' },
      });
      logLlmPhaseBranch(env, TurnEngineBranch.llm.parseRecoverGreeting, 'LLM JSON parse failed; recovered with greeting reply.');
      return turnPhaseComplete(
        {
          message: greetingMessage,
          contact,
          conversation: refs.conversation,
          turnResult: null,
        },
        { branchTaken: 'llm_parse_social_greeting' },
      );
    }
    if (isSimpleInfoIntent(routedContent)) {
      const infoIntentMessage = await insertMessage({
        conversation_id,
        role: 'ai',
        content: SIMPLE_INFO_INTENT_REPLY,
        metadata: { type: 'simple_info_intent' },
      });
      logLlmPhaseBranch(env, TurnEngineBranch.llm.parseRecoverInfo, 'LLM JSON parse failed; recovered with info intent reply.');
      return turnPhaseComplete(
        {
          message: infoIntentMessage,
          contact,
          conversation: await saveState(conversation_id, state),
          turnResult: null,
        },
        { branchTaken: 'llm_parse_simple_info' },
      );
    }
    if (stateMeta.booking_path_choice_open === true) {
      const selfServiceUrl = process.env.BOOKING_SELF_SERVICE_URL?.trim() ?? '';
      if (selfServiceUrl) {
        const optionMessage = await insertMessage({
          conversation_id,
          role: 'ai',
          content: BOOKING_PATH_STRICT_PROMPT,
          metadata: {
            type: 'quick_booking_path_choice',
            options: QUICK_BOOKING_PATH_OPTIONS,
          },
        });
        logLlmPhaseBranch(
          env,
          TurnEngineBranch.llm.parseRecoverPathGate,
          'LLM JSON parse failed; strict booking path gate prompt.',
        );
        return turnPhaseComplete(
          {
            message: optionMessage,
            contact,
            conversation: refs.conversation,
            turnResult: null,
          },
          { branchTaken: 'llm_parse_booking_path_strict' },
        );
      }
    }
    const bookingFallbackPrompt = getNextPromptForIntentFromState(state, state.current_intent);
    if (bookingFallbackPrompt?.prompt) {
      const guidedMetadata =
        bookingFallbackPrompt.field === 'patient.new_or_returning'
          ? {
              type: 'patient_status_choice',
              field: 'new_or_returning',
              options: [
                { label: 'Es mi primera vez', value: 'patient_status_new' },
                { label: 'Ya he venido antes', value: 'patient_status_returning' },
              ],
            }
          : bookingFallbackPrompt.field === 'appointment.preferred_time'
            ? {
                type: 'time_preference_choice',
                field: 'preferred_time',
                options: [
                  { label: 'Mañana', value: 'time_morning' },
                  { label: 'Tarde', value: 'time_afternoon' },
                  { label: 'Hora concreta', value: 'time_exact' },
                ],
              }
            : bookingFallbackPrompt.field === 'appointment.service_type'
              ? {
                  type: 'service_choice_fallback',
                  field: 'service_type',
                  options: [
                    { label: 'Limpieza', value: 'service_cleaning' },
                    { label: 'Revisión', value: 'service_checkup' },
                    { label: 'Ortodoncia', value: 'service_ortho' },
                  ],
                }
              : bookingFallbackPrompt.field === 'appointment.preferred_date'
                ? {
                    type: 'date_choice_fallback',
                    field: 'preferred_date',
                    options: [
                      { label: 'Hoy', value: 'date_today' },
                      { label: 'Mañana', value: 'date_tomorrow' },
                      { label: 'Esta semana', value: 'date_this_week' },
                    ],
                  }
                : { type: 'parse_error_guided', field: bookingFallbackPrompt.field };
      const guidedMessage = await insertMessage({
        conversation_id,
        role: 'ai',
        content: bookingFallbackPrompt.prompt,
        metadata: guidedMetadata,
      });
      logLlmPhaseBranch(
        env,
        TurnEngineBranch.llm.parseRecoverGuidedField,
        'LLM JSON parse failed; next guided field prompt.',
      );
      return turnPhaseComplete(
        {
          message: guidedMessage,
          contact,
          conversation: refs.conversation,
          turnResult: null,
        },
        { branchTaken: 'llm_parse_guided_field_fallback' },
      );
    }
    const priorPatientTextsParse = await getPriorPatientMessageTexts(conversation_id);
    const intakeResult = await tryDeterministicIntakeCapture({
      state,
      content: routedContent,
      conversation_id,
      contact: refs.contact,
      getConversationById,
      priorPatientTexts: priorPatientTextsParse,
    });
    if (intakeResult) {
      logLlmPhaseBranch(
        env,
        TurnEngineBranch.llm.parseRecoverIntake,
        'LLM JSON parse failed; deterministic intake completed the turn.',
      );
      return turnPhaseComplete(intakeResult, { branchTaken: 'llm_parse_deterministic_intake' });
    }
    const fallbackMessage = await insertMessage({
      conversation_id,
      role: 'ai',
      content: 'Perdona, no te he entendido bien 😊 ¿Me lo puedes decir de otra forma?',
      metadata: { type: 'parse_error_fallback' },
    });
    logLlmPhaseBranch(env, TurnEngineBranch.llm.parseRecoverGeneric, 'LLM JSON parse failed; generic clarification reply.');
    return turnPhaseComplete(
      {
        message: fallbackMessage,
        contact,
        conversation: refs.conversation,
        turnResult: null,
      },
      { branchTaken: 'llm_parse_generic_fallback' },
    );
  }

  const bookingSideQuestionFollowup = buildBookingSideQuestionFollowup({
    patientMessage: routedContent,
    state: turnResult.state,
    currentReply: turnResult.reply,
    nextAction: turnResult.rawOutput.next_action,
    shouldEscalate: turnResult.escalation.shouldEscalate,
    getNextPrompt: getNextPromptForIntentFromState,
  });
  if (bookingSideQuestionFollowup) {
    turnResult.reply = `${turnResult.reply.trim()}\n\n${bookingSideQuestionFollowup}`;
  }

  {
    const lastAi = history.slice().reverse().find((m) => m.role === 'ai');
    if (lastAi) {
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
      if (norm(turnResult.reply) === norm(lastAi.content)) {
        turnResult.reply =
          '¿Te ayudo con algo más? Si quieres, puedo ayudarte con horarios, ' +
          'precios o cualquier otra consulta de la clínica.';
        log('info', 'chat.repeat_question_avoided', { conversation_id });
      }
    }
  }

  log('info', 'chat.turn_processed', {
    conversation_id,
    intent: turnResult.rawOutput.intent,
    intent_confidence: turnResult.rawOutput.intent_confidence,
    fallback_applied: turnResult.fallback.applied,
  });

  if (turnResult.flowValidation.overridden) {
    log('warn', 'chat.unexpected_flow', {
      conversation_id,
      original_action: turnResult.flowValidation.originalAction,
      corrected_action: turnResult.flowValidation.correctedAction,
      reason: turnResult.flowValidation.reason,
    });
  }

  if (turnResult.rawOutput.is_correction && turnResult.rawOutput.correction_fields.length > 0) {
    log('info', 'chat.correction_applied', {
      conversation_id,
      correction_fields: turnResult.rawOutput.correction_fields,
    });
  }

  logLlmPhaseBranch(
    env,
    TurnEngineBranch.llm.okContinue,
    `Model output valid; continuing to side_effects (next_action=${turnResult.rawOutput.next_action}).`,
    turnResult.state,
  );
  return turnPhaseContinueWithLlm({ turnResult, history, llmResult });
}
