import { describe, expect, it } from 'vitest';
import {
  classifyConfirmation,
  detectCorrectionSignals,
  isPlainDecline,
  normalizeConfirmationText,
} from './confirmation';

describe('classifyConfirmation', () => {
  it('treats plain affirmations as yes', () => {
    expect(classifyConfirmation('ok')).toBe('yes');
    expect(classifyConfirmation('OK')).toBe('yes');
    expect(classifyConfirmation('vale')).toBe('yes');
    expect(classifyConfirmation('vale perfecto')).toBe('yes');
    expect(classifyConfirmation('sí')).toBe('yes');
    expect(classifyConfirmation('confirmo')).toBe('yes');
  });

  it('treats plain decline as no', () => {
    expect(classifyConfirmation('no')).toBe('no');
    expect(classifyConfirmation('no gracias')).toBe('no');
    expect(classifyConfirmation('cancelar')).toBe('no');
  });

  it('returns ambiguous for mixed intent (sí/ok/vale + pero or cambia)', () => {
    expect(classifyConfirmation('sí pero cambia')).toBe('ambiguous');
    expect(classifyConfirmation('sí pero cambia la hora')).toBe('ambiguous');
    expect(classifyConfirmation('ok pero mejor otro día')).toBe('ambiguous');
    expect(classifyConfirmation('vale cambia')).toBe('ambiguous');
    expect(classifyConfirmation('vale cambiar la fecha')).toBe('ambiguous');
  });

  it('returns ambiguous for correction / slot objection, not a bare no', () => {
    expect(classifyConfirmation('no quiero esa hora')).toBe('ambiguous');
    expect(classifyConfirmation('mejor a las 17')).toBe('ambiguous');
  });

  it('returns ambiguous when polarities conflict', () => {
    expect(classifyConfirmation('sí no')).toBe('ambiguous');
  });

  it('returns ambiguous for uncertainty phrases', () => {
    expect(classifyConfirmation('no sé si')).toBe('ambiguous');
  });
});

describe('detectCorrectionSignals', () => {
  it('is false for clear one-shot affirmations', () => {
    expect(detectCorrectionSignals('ok')).toBe(false);
    expect(detectCorrectionSignals('vale perfecto')).toBe(false);
    expect(detectCorrectionSignals('sí')).toBe(false);
  });

  it('is true when correction or date/time change appears', () => {
    expect(detectCorrectionSignals('vale cambia')).toBe(true);
    expect(detectCorrectionSignals('ok pero mañana')).toBe(true);
    expect(detectCorrectionSignals('pero la hora no')).toBe(true);
  });

  it('is false for bare no', () => {
    expect(detectCorrectionSignals('no')).toBe(false);
    expect(detectCorrectionSignals('no gracias')).toBe(false);
  });
});

describe('normalizeConfirmationText', () => {
  it('strips accents for matching', () => {
    expect(normalizeConfirmationText('Sí')).toBe('si');
    expect(normalizeConfirmationText('DÍA')).toBe('dia');
  });
});

describe('isPlainDecline', () => {
  it('matches clear declines without human-request cues', () => {
    expect(isPlainDecline('no')).toBe(true);
    expect(isPlainDecline('no gracias')).toBe(true);
    expect(isPlainDecline('mejor no')).toBe(true);
    expect(isPlainDecline('no quiero esa hora')).toBe(false);
    expect(isPlainDecline('sí')).toBe(false);
  });

  it('is false when the patient asks for a person even if "no" appears', () => {
    expect(isPlainDecline('no, quiero hablar con una persona')).toBe(false);
    expect(isPlainDecline('no, ponme con una persona')).toBe(false);
  });
});
