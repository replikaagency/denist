/**
 * Flow Rules Engine — single source of truth for conversational phase,
 * LLM eligibility, and strict-gate detection (vs duplicated flags in chat.service).
 */

import type { ConversationState } from './schema';
import { getMissingFields, fieldQueryOptionsFromState } from './fields';
import { logConversationFlow } from '@/lib/logger/flow-logger';

export type FlowStep =
  | 'entry'
  | 'choose_path'
  | 'phone_required'
  | 'name_capture'
  | 'booking_intent'
  | 'slot_selection'
  | 'confirmation'
  | 'completed';

export type FlowRule = {
  step: FlowStep;
  requires: string[];
  blocksLLM: boolean;
  allowedInputs: string[];
  next: FlowStep[];
};

/** Canonical rules table (documentation + future tooling). Runtime logic is in getNextStep. */
export const FLOW_RULES: FlowRule[] = [
  {
    step: 'entry',
    requires: [],
    blocksLLM: false,
    allowedInputs: ['*'],
    next: ['choose_path', 'booking_intent'],
  },
  {
    step: 'choose_path',
    requires: ['metadata.booking_path_choice_open | metadata.optional_email_choice_open'],
    blocksLLM: true,
    allowedInputs: ['1', '1.', '1)', '2', '2.', '2)', 'quick_path_direct', 'quick_path_reception', 'email_add_yes', 'email_add_no'],
    next: ['phone_required', 'slot_selection', 'completed'],
  },
  {
    step: 'confirmation',
    requires: ['awaiting_confirmation'],
    blocksLLM: true,
    allowedInputs: ['confirm_yes', 'confirm_change', 'yes_no_classification'],
    next: ['completed', 'slot_selection'],
  },
  {
    step: 'phone_required',
    requires: [
      'appointment_request',
      'missing patient.phone',
      '(strict) metadata.reception_phone_strict_gate → blocksLLM until valid ES phone',
    ],
    blocksLLM: false,
    allowedInputs: ['phone', 'intake_guard', 'valid_es_phone_only_when_strict_gate'],
    next: ['name_capture', 'booking_intent'],
  },
  {
    step: 'name_capture',
    requires: ['appointment_request', 'missing patient.full_name'],
    blocksLLM: false,
    allowedInputs: ['full_name', 'intake_guard'],
    next: ['booking_intent'],
  },
  {
    step: 'booking_intent',
    requires: ['scheduling_intent', 'missing service or patient status'],
    blocksLLM: false,
    allowedInputs: ['*'],
    next: ['slot_selection', 'confirmation'],
  },
  {
    step: 'slot_selection',
    requires: ['scheduling_intent', 'missing date/time or reschedule active'],
    blocksLLM: false,
    allowedInputs: ['*'],
    next: ['confirmation', 'completed'],
  },
  {
    step: 'completed',
    requires: ['completed'],
    blocksLLM: false,
    allowedInputs: ['*'],
    next: ['entry', 'booking_intent'],
  },
];

export type FlowStepResult = {
  step: FlowStep;
  reason: string;
  allowLLM: boolean;
};

function meta(state: ConversationState): Record<string, unknown> {
  return state.metadata as Record<string, unknown>;
}

/** True while a strict 1/2 (or equivalent) branch is open — LLM must not run for that turn's main path. */
export function isStrictBinaryFlowOpen(state: ConversationState): boolean {
  const m = meta(state);
  return m.booking_path_choice_open === true || m.optional_email_choice_open === true;
}

/** Post-completion optional email 1/2 (separate from quick-booking path choice). */
export function isOptionalEmailFollowupOpen(state: ConversationState): boolean {
  return meta(state).optional_email_choice_open === true;
}

/**
 * After choosing option 2 (recepción) from `booking_path_choice_open`, the patient must
 * send a valid Spanish phone before any LLM or side flows — until `patient.phone` is set.
 */
export function isReceptionPhoneStrictGateActive(state: ConversationState): boolean {
  const m = meta(state);
  return m.reception_phone_strict_gate === true && !state.patient.phone;
}

/** Flow snapshot without side effects (no log line). Use after state mutations to label `resulting_next_step`. */
export function peekFlowStep(state: ConversationState): FlowStepResult {
  return resolveNextFlowStep(state);
}

function resolveNextFlowStep(state: ConversationState): FlowStepResult {
  const m = meta(state);

  if (state.awaiting_confirmation) {
    return { step: 'confirmation', reason: 'awaiting_confirmation', allowLLM: false };
  }

  if (m.booking_path_choice_open === true || m.optional_email_choice_open === true) {
    return { step: 'choose_path', reason: 'strict_binary_gate', allowLLM: false };
  }

  if (isReceptionPhoneStrictGateActive(state)) {
    return {
      step: 'phone_required',
      reason: 'reception_path_choice_phone_gate',
      allowLLM: false,
    };
  }

  if (m.asap_slot_choice_open === true) {
    return {
      step: 'slot_selection',
      reason: 'asap_slot_choice',
      allowLLM: false,
    };
  }

  if (state.completed && !state.awaiting_confirmation) {
    return { step: 'completed', reason: 'flow_marked_completed', allowLLM: true };
  }

  if (state.reschedule_phase === 'selecting_target') {
    return { step: 'slot_selection', reason: 'reschedule_selecting_target', allowLLM: true };
  }

  if (state.current_intent === 'appointment_reschedule' && state.reschedule_phase === 'collecting_new_details') {
    return { step: 'slot_selection', reason: 'reschedule_collecting_new_details', allowLLM: true };
  }

  if (state.current_intent === 'appointment_request') {
    const filled = {
      patient: state.patient,
      appointment: state.appointment,
      symptoms: state.symptoms,
    };
    const opts = fieldQueryOptionsFromState(state);
    const missing = getMissingFields('appointment_request', filled, opts);

    if (missing.includes('patient.phone')) {
      return { step: 'phone_required', reason: 'missing_patient.phone', allowLLM: true };
    }
    if (missing.includes('patient.full_name')) {
      return { step: 'name_capture', reason: 'missing_patient.full_name', allowLLM: true };
    }
    if (missing.includes('patient.new_or_returning')) {
      return { step: 'booking_intent', reason: 'missing_patient.new_or_returning', allowLLM: true };
    }
    if (missing.includes('appointment.service_type')) {
      return { step: 'booking_intent', reason: 'missing_appointment.service_type', allowLLM: true };
    }
    if (missing.includes('appointment.preferred_date') || missing.includes('appointment.preferred_time')) {
      return { step: 'slot_selection', reason: 'missing_date_or_time', allowLLM: true };
    }
  }

  if (!state.current_intent) {
    return { step: 'entry', reason: 'no_current_intent', allowLLM: true };
  }

  return { step: 'booking_intent', reason: 'default_intent_flow', allowLLM: true };
}

export type FlowLogContext = {
  conversation_id?: string;
};

/**
 * Derives the active flow step and whether the LLM may be invoked for this turn.
 * Logs one structured `conversation_flow` line per call (see flow-logger).
 */
export function getNextStep(
  state: ConversationState,
  input: string,
  ctx?: FlowLogContext,
): FlowStepResult {
  const result = peekFlowStep(state);
  logConversationFlow({
    conversation_id: ctx?.conversation_id,
    phone: state.patient.phone ?? null,
    step: result.step,
    input,
    branch_taken: result.reason,
    reason: result.allowLLM ? 'llm_eligible' : 'llm_blocked',
  });
  return result;
}
