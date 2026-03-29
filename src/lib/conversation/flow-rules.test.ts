import { describe, expect, it, vi } from 'vitest';
import { createInitialState } from './schema';

vi.mock('@/lib/logger/flow-logger', () => ({
  logConversationFlow: vi.fn(),
}));
import {
  FLOW_RULES,
  getNextStep,
  isOptionalEmailFollowupOpen,
  isReceptionPhoneStrictGateActive,
  isStrictBinaryFlowOpen,
} from './flow-rules';

describe('flow-rules', () => {
  it('exposes a rule per FlowStep', () => {
    const steps = new Set(FLOW_RULES.map((r) => r.step));
    expect(steps.has('entry')).toBe(true);
    expect(steps.has('choose_path')).toBe(true);
    expect(steps.has('confirmation')).toBe(true);
    expect(FLOW_RULES.length).toBeGreaterThanOrEqual(8);
  });

  it('getNextStep: strict booking path blocks LLM', () => {
    const state = createInitialState('c1');
    (state.metadata as Record<string, unknown>).booking_path_choice_open = true;
    const r = getNextStep(state, 'hola');
    expect(r.step).toBe('choose_path');
    expect(r.allowLLM).toBe(false);
    expect(isStrictBinaryFlowOpen(state)).toBe(true);
  });

  it('getNextStep: optional email follow-up is choose_path and blocks LLM', () => {
    const state = createInitialState('c2');
    state.completed = true;
    (state.metadata as Record<string, unknown>).optional_email_choice_open = true;
    const r = getNextStep(state, '1');
    expect(r.step).toBe('choose_path');
    expect(r.allowLLM).toBe(false);
    expect(isOptionalEmailFollowupOpen(state)).toBe(true);
  });

  it('getNextStep: awaiting_confirmation blocks LLM', () => {
    const state = createInitialState('c3');
    state.awaiting_confirmation = true;
    const r = getNextStep(state, 'sí');
    expect(r.step).toBe('confirmation');
    expect(r.allowLLM).toBe(false);
  });

  it('getNextStep: missing phone → phone_required, LLM allowed', () => {
    const state = createInitialState('c4');
    state.current_intent = 'appointment_request';
    (state.metadata as Record<string, unknown>).reception_intake_phone_first = true;
    const r = getNextStep(state, '612345678');
    expect(r.step).toBe('phone_required');
    expect(r.allowLLM).toBe(true);
  });

  it('getNextStep: no intent → entry', () => {
    const state = createInitialState('c5');
    const r = getNextStep(state, 'hola');
    expect(r.step).toBe('entry');
    expect(r.allowLLM).toBe(true);
  });

  it('getNextStep: reception_phone_strict_gate → phone_required, blocks LLM', () => {
    const state = createInitialState('c6');
    state.current_intent = 'appointment_request';
    (state.metadata as Record<string, unknown>).reception_phone_strict_gate = true;
    const r = getNextStep(state, 'hola');
    expect(r.step).toBe('phone_required');
    expect(r.reason).toBe('reception_path_choice_phone_gate');
    expect(r.allowLLM).toBe(false);
    expect(isReceptionPhoneStrictGateActive(state)).toBe(true);
  });

  it('isReceptionPhoneStrictGateActive is false once patient.phone is set', () => {
    const state = createInitialState('c7');
    (state.metadata as Record<string, unknown>).reception_phone_strict_gate = true;
    state.patient.phone = '+34600111222';
    expect(isReceptionPhoneStrictGateActive(state)).toBe(false);
  });

  it('getNextStep: asap_slot_choice_open blocks LLM', () => {
    const state = createInitialState('c8');
    state.current_intent = 'appointment_request';
    (state.metadata as Record<string, unknown>).asap_slot_choice_open = true;
    const r = getNextStep(state, '1');
    expect(r.step).toBe('slot_selection');
    expect(r.reason).toBe('asap_slot_choice');
    expect(r.allowLLM).toBe(false);
  });
});
