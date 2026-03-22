import { describe, expect, it } from 'vitest';
import { detectAvailabilityStyleMessage } from './hybrid-booking-detection';

describe('detectAvailabilityStyleMessage', () => {
  it('detects morning-only and weekday-only phrasing', () => {
    expect(detectAvailabilityStyleMessage('solo puedo por las mañanas')).toBe(true);
    expect(detectAvailabilityStyleMessage('Solo los lunes me va bien')).toBe(true);
  });

  it('detects after-hours and waitlist phrasing', () => {
    expect(detectAvailabilityStyleMessage('a partir de las 18:00')).toBe(true);
    expect(detectAvailabilityStyleMessage('avisadme si queda hueco')).toBe(true);
    expect(detectAvailabilityStyleMessage('cualquier hueco me vale')).toBe(true);
  });

  it('returns false for generic text', () => {
    expect(detectAvailabilityStyleMessage('hola')).toBe(false);
    expect(detectAvailabilityStyleMessage('quiero una limpieza')).toBe(false);
  });
});
