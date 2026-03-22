import { describe, expect, it } from 'vitest';
import { checkEscalation, parseLLMOutput, processTurn } from './engine';
import { createInitialState } from './schema';
import type { LLMTurnOutput } from './schema';
import { DECLINE_OFFER_FOLLOWUP_REPLY_ES } from './confirmation';

function baseOutput(overrides: Partial<LLMTurnOutput>): LLMTurnOutput {
  return {
    intent: 'service_inquiry',
    intent_confidence: 0.9,
    secondary_intent: null,
    urgency: 'informational',
    urgency_reasoning: 'Informative exchange.',
    patient_fields: {},
    appointment: {},
    symptoms: {},
    next_action: 'continue',
    missing_fields: [],
    escalation_reason: null,
    reply: 'De acuerdo.',
    contains_diagnosis: false,
    contains_pricing: false,
    is_correction: false,
    correction_fields: [],
    ...overrides,
  };
}

function stringifyOutput(o: LLMTurnOutput): string {
  return JSON.stringify(o);
}

describe('checkEscalation — plain decline vs handoff', () => {
  const state = createInitialState('c1');

  it('does not escalate on model escalate_human when intent is denial', () => {
    const out = baseOutput({
      intent: 'denial',
      next_action: 'escalate_human',
      escalation_reason: 'wrong',
    });
    expect(checkEscalation(out, state)).toEqual({
      shouldEscalate: false,
      reason: null,
      type: null,
    });
  });

  it('does not escalate on model escalate_human when utterance is plain "no"', () => {
    const out = baseOutput({
      intent: 'unknown',
      intent_confidence: 0.4,
      next_action: 'escalate_human',
      escalation_reason: 'wrong',
    });
    expect(checkEscalation(out, state, 'no')).toEqual({
      shouldEscalate: false,
      reason: null,
      type: null,
    });
  });

  it('still escalates on explicit human handoff intent', () => {
    const out = baseOutput({
      intent: 'human_handoff_request',
      next_action: 'continue',
    });
    expect(checkEscalation(out, state, 'quiero hablar con una persona')).toEqual({
      shouldEscalate: true,
      reason: 'Patient explicitly requested to speak with a person.',
      type: 'human',
    });
  });

  it('still escalates on complaint intent', () => {
    const out = baseOutput({ intent: 'complaint', next_action: 'continue' });
    expect(checkEscalation(out, state)).toMatchObject({
      shouldEscalate: true,
      type: 'human',
    });
  });
});

describe('processTurn — service decline must not hand off or end chat', () => {
  it('plain "no" + escalate_human: no escalation', () => {
    const s = createInitialState('c2');
    s.offer_appointment_pending = true;
    const out = stringifyOutput(
      baseOutput({
        intent: 'unknown',
        intent_confidence: 0.5,
        next_action: 'escalate_human',
        escalation_reason: 'Paciente confuso',
        reply: 'Te paso con alguien.',
      }),
    );
    const result = processTurn(out, s, 'no');
    if ('error' in result) throw new Error(result.error);
    expect(result.escalation.shouldEscalate).toBe(false);
    expect(result.state.escalated).toBe(false);
  });

  it('plain "no" + end_conversation: forces continue and follow-up copy', () => {
    const s = createInitialState('c3');
    const out = stringifyOutput(
      baseOutput({
        intent: 'service_inquiry',
        next_action: 'end_conversation',
        reply: 'Hasta luego.',
      }),
    );
    const result = processTurn(out, s, 'no gracias');
    if ('error' in result) throw new Error(result.error);
    expect(result.rawOutput.next_action).toBe('continue');
    expect(result.reply).toBe(DECLINE_OFFER_FOLLOWUP_REPLY_ES);
  });

  it('resets consecutive_low_confidence on plain decline', () => {
    const s = createInitialState('c4');
    s.consecutive_low_confidence = 2;
    const out = stringifyOutput(
      baseOutput({
        intent: 'unknown',
        intent_confidence: 0.4,
        next_action: 'continue',
        reply: '¿Podrías aclarar?',
      }),
    );
    const result = processTurn(out, s, 'no');
    if ('error' in result) throw new Error(result.error);
    expect(result.state.consecutive_low_confidence).toBe(0);
  });

  it('still escalates on third consecutive low-confidence turn when utterance is not a plain decline', () => {
    const s = createInitialState('c5');
    s.consecutive_low_confidence = 2;
    const out = stringifyOutput(
      baseOutput({
        intent: 'unknown',
        intent_confidence: 0.4,
        next_action: 'continue',
        reply: '¿Podrías concretar un poco más?',
      }),
    );
    const result = processTurn(out, s, 'a lo mejor');
    if ('error' in result) throw new Error(result.error);
    expect(result.escalation.shouldEscalate).toBe(true);
    expect(result.escalation.type).toBe('human');
  });
});

describe('parseLLMOutput — resilience for hybrid_booking + JSON', () => {
  it('coerces string preferred_* arrays on hybrid_booking', () => {
    const o = baseOutput({
      intent: 'appointment_request',
      next_action: 'ask_field',
      reply: 'Entendido.',
    });
    const raw = JSON.stringify({
      ...o,
      hybrid_booking: {
        booking_mode: 'availability_capture',
        preferred_time_ranges: 'por la mañana',
        preferred_days: 'lunes',
        service_interest: 'ortodoncia',
      },
    });
    const r = parseLLMOutput(raw);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.hybrid_booking?.preferred_time_ranges).toEqual(['por la mañana']);
      expect(r.data.hybrid_booking?.preferred_days).toEqual(['lunes']);
    }
  });

  it('parses JSON wrapped in markdown fences', () => {
    const o = baseOutput({ intent: 'appointment_request', next_action: 'ask_field', reply: 'Ok.' });
    const raw = '```json\n' + JSON.stringify(o) + '\n```';
    expect(parseLLMOutput(raw).success).toBe(true);
  });
});
