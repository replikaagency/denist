import { describe, expect, it } from 'vitest';
import {
  appendDirectLinkToReply,
  buildHybridAvailabilityPayload,
  formatAvailabilityCapturedEs,
  hybridOfferTwoWaysBlockEs,
  mergeAvailabilityCaptureReply,
  mergeDirectBookingChoiceReply,
  mergeHybridOfferTwoWaysReply,
  stripHybridCommittalLeadIn,
  thankDirectBookingChoiceEs,
} from './hybrid-booking.service';
import { createInitialState } from '@/lib/conversation/schema';
import { extractHybridAvailabilityHintsFromText } from '@/lib/conversation/hybrid-booking-detection';

describe('buildHybridAvailabilityPayload', () => {
  it('merges LLM arrays and appointment.preferred_time into ranges', () => {
    const state = createInitialState('c1');
    state.appointment.service_type = 'Limpieza';
    state.appointment.preferred_time = 'por la mañana';
    const payload = buildHybridAvailabilityPayload(
      {
        preferred_days: ['lunes'],
        preferred_time_ranges: ['a partir de las 18:00'],
        wants_callback: true,
        booking_mode: 'availability_capture',
      },
      state,
      'solo lunes',
    );
    expect(payload.service_interest).toBe('Limpieza');
    expect(payload.preferred_days).toEqual(['lunes']);
    expect(payload.preferred_time_ranges).toEqual(['a partir de las 18:00']);
    expect(payload.booking_mode).toBe('availability_capture');
    expect(payload.wants_callback).toBe(true);
  });

  it('uses callback_request mode from signal', () => {
    const state = createInitialState('c2');
    const payload = buildHybridAvailabilityPayload(
      { booking_mode: 'callback_request', wants_callback: true },
      state,
      'llamadme',
    );
    expect(payload.booking_mode).toBe('callback_request');
  });

  it('fills service + time ranges from text when LLM hybrid_booking is empty', () => {
    const state = createInitialState('c-combined');
    const msg = 'solo puedo por las mañanas y quiero ortodoncia';
    const hints = extractHybridAvailabilityHintsFromText(msg);
    const payload = buildHybridAvailabilityPayload(null, state, msg, hints);
    expect(payload.service_interest).toMatch(/ortodoncia/i);
    expect(payload.preferred_time_ranges.join(' ')).toMatch(/mañana/i);
  });

  it('fills limpieza + lunes from combined message without LLM fields', () => {
    const state = createInitialState('c-combined-2');
    const msg = 'quiero limpieza, pero solo lunes';
    const hints = extractHybridAvailabilityHintsFromText(msg);
    const payload = buildHybridAvailabilityPayload(null, state, msg, hints);
    expect(payload.service_interest).toMatch(/limpieza/i);
    expect(payload.preferred_days).toContain('lunes');
  });
});

describe('appendDirectLinkToReply', () => {
  it('appends URL when not already present', () => {
    const url = 'https://calendly.com/clinic';
    const out = appendDirectLinkToReply('Gracias.', url);
    expect(out).toContain(url);
  });

  it('does not duplicate URL', () => {
    const url = 'https://calendly.com/x';
    const out = appendDirectLinkToReply(`Abre ${url}`, url);
    expect(out.split(url).length - 1).toBe(1);
  });
});

describe('hybridOfferTwoWaysBlockEs', () => {
  it('includes numbered options and link', () => {
    const b = hybridOfferTwoWaysBlockEs('https://x.test/book');
    expect(b).toContain('👉 https://x.test/book');
    expect(b).toContain('dos formas');
    expect(b).toContain('equipo te contacta');
  });
});

describe('formatAvailabilityCapturedEs', () => {
  it('states solicitud (not confirmed) and natural recap', () => {
    const t = formatAvailabilityCapturedEs({
      service_interest: 'Limpieza',
      preferred_days: ['lunes', 'miércoles'],
      preferred_time_ranges: ['después de las 18:00'],
      availability_notes: null,
      wants_callback: true,
      booking_mode: 'availability_capture',
    });
    expect(t).toMatch(/solicitud,\s+no\s+una\s+cita\s+confirmada/i);
    expect(t).toMatch(/He anotado que prefieres Limpieza/);
    expect(t).toContain('lunes');
    expect(t).toContain('18:00');
    expect(t).toMatch(/registrarla/i);
  });
});

describe('stripHybridCommittalLeadIn', () => {
  it('removes committal first sentence and keeps follow-up', () => {
    const out = stripHybridCommittalLeadIn(
      'Perfecto, te apunto para ortodoncia los lunes. ¿Me das tu teléfono?',
    );
    expect(out).toContain('teléfono');
    expect(out).not.toMatch(/te apunto/i);
  });
});

describe('mergeHybridOfferTwoWaysReply', () => {
  it('appends block when missing', () => {
    const out = mergeHybridOfferTwoWaysReply('De acuerdo.', 'https://a.io');
    expect(out).toContain('dos formas');
    expect(out).toContain('https://a.io');
  });

  it('does not duplicate when block already present', () => {
    const url = 'https://a.io';
    const once = mergeHybridOfferTwoWaysReply('Ok.', url);
    const twice = mergeHybridOfferTwoWaysReply(once, url);
    expect(twice.split('dos formas').length - 1).toBe(1);
  });
});

describe('mergeDirectBookingChoiceReply', () => {
  it('adds thanks and link when missing', () => {
    const out = mergeDirectBookingChoiceReply('Perfecto.', 'https://book.test');
    expect(out).toContain('enlace eliges tú el hueco disponible');
    expect(out).toContain('https://book.test');
  });
});

describe('mergeAvailabilityCaptureReply', () => {
  it('puts safe recap first and appends stripped LLM follow-up', () => {
    const payload = buildHybridAvailabilityPayload(
      { preferred_days: ['lunes'], booking_mode: 'availability_capture' },
      createInitialState('cx'),
      'solo lunes',
    );
    const out = mergeAvailabilityCaptureReply('Entendido.', payload);
    expect(out).toMatch(/^He anotado que/);
    expect(out).toMatch(/solicitud,\s+no\s+una\s+cita\s+confirmada/i);
    expect(out).toContain('Entendido.');
  });

  it('skips if reply already has disclaimer', () => {
    const payload = buildHybridAvailabilityPayload(null, createInitialState('cy'), 'x');
    const out = mergeAvailabilityCaptureReply('Ya te dije que no es una cita confirmada.', payload);
    expect(out).toBe('Ya te dije que no es una cita confirmada.');
  });

  it('drops committal LLM opener and keeps question after deterministic block', () => {
    const payload = buildHybridAvailabilityPayload(
      { service_interest: 'ortodoncia', preferred_days: ['lunes'], booking_mode: 'availability_capture' },
      createInitialState('cz'),
      'solo lunes ortodoncia',
    );
    const out = mergeAvailabilityCaptureReply(
      'Perfecto, te apunto para ortodoncia los lunes. ¿Tu número de teléfono?',
      payload,
    );
    expect(out.indexOf('He anotado que')).toBeLessThan(out.indexOf('teléfono'));
    expect(out).not.toMatch(/te apunto/i);
  });
});
