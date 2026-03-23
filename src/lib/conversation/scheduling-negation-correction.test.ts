import { describe, expect, it } from 'vitest';
import {
  extractSchedulingPreferenceFromNegationCorrection,
  isNegationLedSchedulingCorrection,
  tryBuildSyntheticNegationSchedulingCorrectionJson,
} from './scheduling-negation-correction';
import { createInitialState } from '@/lib/conversation/schema';
import { processTurn } from '@/lib/conversation/engine';
import { isPlainDecline } from '@/lib/conversation/confirmation';

describe('isNegationLedSchedulingCorrection', () => {
  it('is true for no + scheduling correction', () => {
    expect(isNegationLedSchedulingCorrection('no pero mejor el martes')).toBe(true);
    expect(isNegationLedSchedulingCorrection('no, mejor por la mañana')).toBe(true);
    expect(isNegationLedSchedulingCorrection('no, en vez del lunes el martes')).toBe(true);
    expect(isNegationLedSchedulingCorrection('no, cambiar a jueves')).toBe(true);
    expect(isNegationLedSchedulingCorrection('no pero solo a partir de las 18')).toBe(true);
  });

  it('is false for bare denial', () => {
    expect(isNegationLedSchedulingCorrection('no')).toBe(false);
    expect(isNegationLedSchedulingCorrection('no gracias')).toBe(false);
  });
});

describe('extractSchedulingPreferenceFromNegationCorrection', () => {
  it('extracts weekday from "no pero mejor el martes"', () => {
    const e = extractSchedulingPreferenceFromNegationCorrection('no pero mejor el martes');
    expect(e?.preferred_date?.toLowerCase()).toBe('martes');
  });

  it('extracts morning from "no, mejor por la mañana"', () => {
    const e = extractSchedulingPreferenceFromNegationCorrection('no, mejor por la mañana');
    expect(e?.preferred_time).toBe('morning');
  });

  it('extracts jueves from "no, cambiar a jueves"', () => {
    const e = extractSchedulingPreferenceFromNegationCorrection('no, cambiar a jueves');
    expect(e?.preferred_date?.toLowerCase()).toBe('jueves');
  });

  it('extracts after-hours from "no pero solo a partir de las 18"', () => {
    const e = extractSchedulingPreferenceFromNegationCorrection('no pero solo a partir de las 18');
    expect(e?.preferred_time).toMatch(/18/);
  });
});

describe('tryBuildSyntheticNegationSchedulingCorrectionJson + processTurn', () => {
  it('produces a valid turn with corrected preferred_date (no parse error)', () => {
    const state = createInitialState('c1');
    state.current_intent = 'appointment_request';
    state.appointment.preferred_date = 'lunes';
    state.appointment.preferred_time = 'afternoon';
    state.appointment.service_type = 'Limpieza dental';

    const raw = tryBuildSyntheticNegationSchedulingCorrectionJson('no pero mejor el martes', state);
    expect(raw).toBeTruthy();
    const res = processTurn(raw!, state, 'no pero mejor el martes');
    expect('error' in res).toBe(false);
    if (!('error' in res)) {
      expect(res.rawOutput.is_correction).toBe(true);
      expect(res.state.appointment.preferred_date).toBe('Martes');
      expect(res.state.appointment.service_type).toBe('Limpieza dental');
      expect(res.reply).toMatch(/por la tarde/i);
    }
  });

  it('plain "no" still declines via isPlainDecline and does not use synthetic JSON', () => {
    expect(isPlainDecline('no')).toBe(true);
    const state = createInitialState('c2');
    state.current_intent = 'appointment_request';
    expect(tryBuildSyntheticNegationSchedulingCorrectionJson('no', state)).toBeNull();
  });
});
