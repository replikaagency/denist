import { describe, expect, it } from 'vitest';
import { createInitialState } from './schema';
import {
  ASAP_INTENT,
  applyAsapSlotProposalToState,
  buildAsapSlotProposals,
  detectAsapBookingIntent,
  fetchNextAsapSlots,
  parseAsapSlotChoice,
} from './booking-intent';

describe('booking-intent', () => {
  it('exports ASAP_INTENT sentinel', () => {
    expect(ASAP_INTENT).toBe(true);
  });

  it.each([
    ['cuando puedas', true],
    ['lo antes posible', true],
    ['primera disponible', true],
    ['la primera disponible', true],
    ['cuando haya hueco', true],
    ['quiero limpieza el martes', false],
  ])('detectAsapBookingIntent(%j) → %s', (text, expected) => {
    expect(detectAsapBookingIntent(text)).toBe(expected);
  });

  it('fetchNextAsapSlots returns 3 proposals with iso dates', () => {
    const from = new Date('2026-03-23T12:00:00Z'); // Monday
    const slots = fetchNextAsapSlots(3, from);
    expect(slots).toHaveLength(3);
    expect(slots[0].isoDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(slots[0].displayLine.length).toBeGreaterThan(3);
  });

  it('buildAsapSlotProposals aliases fetch', () => {
    const from = new Date('2026-03-23T12:00:00Z');
    expect(buildAsapSlotProposals(3, from)).toEqual(fetchNextAsapSlots(3, from));
  });

  it.each([
    ['1', 0],
    ['2.', 1],
    ['3)', 2],
    ['asap_slot_0', 0],
    ['asap_slot_2', 2],
    ['hola', null],
  ])('parseAsapSlotChoice(%j) → %s', (text, idx) => {
    expect(parseAsapSlotChoice(text)).toBe(idx);
  });

  it('applyAsapSlotProposalToState fills appointment date and time bucket', () => {
    const state = createInitialState('c1');
    const p = {
      id: 't',
      displayLine: 'test',
      isoDate: '2026-04-01',
      preferredTime: 'morning',
    };
    applyAsapSlotProposalToState(state, p);
    expect(state.appointment.preferred_date).toBe('2026-04-01');
    expect(state.appointment.preferred_time).toBe('morning');
  });
});
