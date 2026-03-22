import { describe, expect, it } from 'vitest';
import {
  detectAvailabilityStyleMessage,
  extractHybridAvailabilityHintsFromText,
} from './hybrid-booking-detection';

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

  it('detects time-of-day without leading solo (combined with service)', () => {
    expect(detectAvailabilityStyleMessage('ortodoncia, por la tarde')).toBe(true);
    expect(detectAvailabilityStyleMessage('quiero limpieza, pero solo lunes')).toBe(true);
  });

  it('returns false for generic text', () => {
    expect(detectAvailabilityStyleMessage('hola')).toBe(false);
    expect(detectAvailabilityStyleMessage('quiero una limpieza')).toBe(false);
  });
});

describe('extractHybridAvailabilityHintsFromText — combined service + availability', () => {
  it('extracts ortodoncia + mañanas from one message', () => {
    const h = extractHybridAvailabilityHintsFromText(
      'solo puedo por las mañanas y quiero ortodoncia',
    );
    expect(h.service_interest).toMatch(/ortodoncia/i);
    expect(h.preferred_time_ranges).toContain('por la mañana');
  });

  it('extracts limpieza + lunes', () => {
    const h = extractHybridAvailabilityHintsFromText('quiero limpieza, pero solo lunes');
    expect(h.service_interest).toMatch(/limpieza/i);
    expect(h.preferred_days).toContain('lunes');
  });

  it('extracts ortodoncia + tarde', () => {
    const h = extractHybridAvailabilityHintsFromText('ortodoncia, por la tarde');
    expect(h.service_interest).toMatch(/ortodoncia/i);
    expect(h.preferred_time_ranges.some((r) => r.includes('tarde'))).toBe(true);
  });

  it('extracts implantes + after 18:00', () => {
    const h = extractHybridAvailabilityHintsFromText('implantes, solo a partir de las 18:00');
    expect(h.service_interest).toMatch(/implantes/i);
    expect(h.preferred_time_ranges.some((r) => r.includes('18'))).toBe(true);
  });
});
