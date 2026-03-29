import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Contact } from '@/types/database';
import type { ConversationState } from '@/lib/conversation/schema';
import {
  ENTRY_REPLY_BOOKING,
  ENTRY_BOOKING_GATE_REPROMPT,
  ENTRY_BOOKING_RETURNING_ASK_PHONE,
  ENTRY_BOOKING_RETURNING_FOUND,
  ENTRY_BOOKING_RETURNING_NOT_FOUND,
  ENTRY_BOOKING_RETURNING_AMBIGUOUS,
  ENTRY_BOOKING_NEW_ASK_DETAILS,
  ENTRY_BOOKING_PATIENT_STATUS_OPTIONS,
} from './response-builder';

// ── Mocks ──────────────────────────────────────────────────────────────────

const { findContactByPhoneMock } = vi.hoisted(() => ({
  findContactByPhoneMock: vi.fn(async (): Promise<Contact | null> => null),
}));

vi.mock('@/lib/db/contacts', () => ({
  findContactByPhone: findContactByPhoneMock,
}));

vi.mock('@/services/conversation.service', () => ({
  saveState: vi.fn(async () => undefined),
  getConversationById: vi.fn(async (id: string) => ({ id, contact_id: 'c1' })),
}));

vi.mock('@/lib/db/messages', () => ({
  insertMessage: vi.fn(async (payload: Record<string, unknown>) => ({
    id: 'm1',
    content: payload.content,
    role: 'ai',
    metadata: payload.metadata,
  })),
}));

vi.mock('@/lib/conversation/turn-engine-log', () => ({
  logTurnEngineBranch: vi.fn(),
}));

vi.mock('@/lib/conversation/turn-engine-branches', () => ({
  TurnEngineBranch: {
    coordinator: { pipelineStart: 'coordinator.pipeline_start' },
  },
}));

// ── Helpers ────────────────────────────────────────────────────────────────

import { handleBookingEntryGate, type BookingGateEnv } from './entry-booking-gate';

beforeEach(async () => {
  const { insertMessage } = await import('@/lib/db/messages');
  vi.mocked(insertMessage).mockClear();
  findContactByPhoneMock.mockReset();
  findContactByPhoneMock.mockResolvedValue(null);
});

function makeState(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    conversation_id: 'cid',
    turn_count: 1,
    current_intent: 'appointment_request',
    current_urgency: 'informational',
    patient: {
      full_name: null,
      phone: null,
      email: null,
      date_of_birth: null,
      new_or_returning: null,
      insurance_provider: null,
      insurance_member_id: null,
    },
    appointment: {
      service_type: null,
      preferred_date: null,
      preferred_time: null,
      preferred_provider: null,
      flexibility: null,
    },
    symptoms: {
      description: null,
      location: null,
      duration: null,
      pain_level: null,
      triggers: null,
      prior_treatment: null,
    },
    escalated: false,
    escalation_reason: null,
    consecutive_low_confidence: 0,
    completed: false,
    offer_appointment_pending: false,
    appointment_request_open: false,
    reschedule_target_id: null,
    reschedule_target_summary: null,
    reschedule_phase: 'idle',
    awaiting_confirmation: false,
    pending_appointment: null,
    confirmation_attempts: 0,
    confirmation_prompt_at: null,
    hybrid_booking_open: false,
    self_service_booking_offer_shown: false,
    collected: {},
    booking: null,
    metadata: {
      correction_log: [],
      correction_count: 0,
      last_correction_at: null,
      too_many_corrections: false,
      booking_patient_status_pending: true,
    } as Record<string, unknown>,
    ...overrides,
  } as ConversationState;
}

function makeEnv(state: ConversationState, content: string, contact?: Partial<Contact>): BookingGateEnv {
  return {
    conversation_id: 'cid',
    routedContent: content,
    state,
    contact: { id: 'c1', phone: null, ...contact } as Contact,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Entry Booking Gate', () => {
  // ==========================================================================
  // 1. First reply (tested via response-builder constants, not the gate itself)
  // ==========================================================================

  test('ENTRY_REPLY_BOOKING has exact product copy', () => {
    expect(ENTRY_REPLY_BOOKING).toBe(
      'Perfecto, te ayudo a pedir tu cita.\n\n¿Ya eres paciente de la clínica o es tu primera vez?',
    );
  });

  test('ENTRY_BOOKING_PATIENT_STATUS_OPTIONS has exactly two options', () => {
    expect(ENTRY_BOOKING_PATIENT_STATUS_OPTIONS).toHaveLength(2);
    expect(ENTRY_BOOKING_PATIENT_STATUS_OPTIONS[0].label).toBe('Ya soy paciente');
    expect(ENTRY_BOOKING_PATIENT_STATUS_OPTIONS[1].label).toBe('Es mi primera vez');
  });

  // ==========================================================================
  // 2. Gate does not run when flag is off
  // ==========================================================================

  test('gate does not handle when booking_patient_status_pending is false', async () => {
    const state = makeState();
    (state.metadata as Record<string, unknown>).booking_patient_status_pending = false;
    const env = makeEnv(state, 'hola');
    const result = await handleBookingEntryGate(env);
    expect(result.handled).toBe(false);
  });

  // ==========================================================================
  // 3. Ambiguous / invalid input re-prompts
  // ==========================================================================

  test('ambiguous reply re-prompts binary gate', async () => {
    const state = makeState();
    const env = makeEnv(state, 'no entiendo la pregunta');
    const result = await handleBookingEntryGate(env);
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.result.message.content).toBe(ENTRY_BOOKING_GATE_REPROMPT);
      expect((result.result.message.metadata as Record<string, unknown>).type).toBe('patient_status_choice');
      expect((result.result.message.metadata as Record<string, unknown>).options).toEqual(ENTRY_BOOKING_PATIENT_STATUS_OPTIONS);
    }
  });

  // ==========================================================================
  // 4. "Es mi primera vez" → new patient
  // ==========================================================================

  test('"es mi primera vez" resolves to new patient, asks for name+phone', async () => {
    const state = makeState();
    const env = makeEnv(state, 'Es mi primera vez');
    const result = await handleBookingEntryGate(env);
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(state.patient.new_or_returning).toBe('new');
      expect(result.result.message.content).toBe(ENTRY_BOOKING_NEW_ASK_DETAILS);
      expect((state.metadata as Record<string, unknown>).booking_patient_status_pending).toBe(false);
    }
  });

  test('button value patient_status_new resolves to new', async () => {
    const state = makeState();
    const env = makeEnv(state, 'patient_status_new');
    const result = await handleBookingEntryGate(env);
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(state.patient.new_or_returning).toBe('new');
    }
  });

  // ==========================================================================
  // 5. "Ya soy paciente" → returning, asks for phone
  // ==========================================================================

  test('"ya soy paciente" without known phone asks for phone', async () => {
    const state = makeState();
    const env = makeEnv(state, 'Ya soy paciente');
    const result = await handleBookingEntryGate(env);
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(state.patient.new_or_returning).toBe('returning');
      expect(result.result.message.content).toBe(ENTRY_BOOKING_RETURNING_ASK_PHONE);
      expect((state.metadata as Record<string, unknown>).booking_returning_awaiting_phone).toBe(true);
      // Gate stays open
      expect((state.metadata as Record<string, unknown>).booking_patient_status_pending).toBe(true);
    }
  });

  // ==========================================================================
  // 6. Returning with phone already in state skips phone request
  // ==========================================================================

  test('returning with phone in state skips phone request, does lookup', async () => {
    findContactByPhoneMock.mockResolvedValueOnce({
      id: 'c2',
      first_name: 'Ana',
      last_name: 'García',
      phone: '+34678123456',
      is_new_patient: false,
    } as Contact);

    const state = makeState();
    state.patient.phone = '+34678123456';
    const env = makeEnv(state, 'Ya soy paciente');
    const result = await handleBookingEntryGate(env);
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.result.message.content).toBe(ENTRY_BOOKING_RETURNING_FOUND);
      expect(state.patient.full_name).toBe('Ana García');
      expect((state.metadata as Record<string, unknown>).booking_patient_status_pending).toBe(false);
    }
  });

  // ==========================================================================
  // 7. Returning + phone lookup found
  // ==========================================================================

  test('returning + phone lookup found says "ya te he localizado"', async () => {
    findContactByPhoneMock.mockResolvedValueOnce({
      id: 'c2',
      first_name: 'Pedro',
      last_name: 'Ruiz',
      phone: '+34600111222',
      is_new_patient: false,
    } as Contact);

    const state = makeState();
    (state.metadata as Record<string, unknown>).booking_returning_awaiting_phone = true;
    state.patient.new_or_returning = 'returning';
    const env = makeEnv(state, '600111222');
    const result = await handleBookingEntryGate(env);
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.result.message.content).toBe(ENTRY_BOOKING_RETURNING_FOUND);
      expect(state.patient.full_name).toBe('Pedro Ruiz');
      expect(state.patient.phone).toBe('+34600111222');
      expect((state.metadata as Record<string, unknown>).booking_patient_status_pending).toBe(false);
    }
  });

  // ==========================================================================
  // 8. Returning + phone not found
  // ==========================================================================

  test('returning + phone not found asks for full name', async () => {
    findContactByPhoneMock.mockResolvedValueOnce(null);

    const state = makeState();
    (state.metadata as Record<string, unknown>).booking_returning_awaiting_phone = true;
    state.patient.new_or_returning = 'returning';
    const env = makeEnv(state, '600999888');
    const result = await handleBookingEntryGate(env);
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.result.message.content).toBe(ENTRY_BOOKING_RETURNING_NOT_FOUND);
      expect((state.metadata as Record<string, unknown>).booking_patient_status_pending).toBe(false);
    }
  });

  // ==========================================================================
  // 9. Multiple match safety (DB throws)
  // ==========================================================================

  test('returning + multiple match (DB error) asks for full name, never auto-selects', async () => {
    findContactByPhoneMock.mockRejectedValueOnce(new Error('maybeSingle: multiple rows'));

    const state = makeState();
    (state.metadata as Record<string, unknown>).booking_returning_awaiting_phone = true;
    state.patient.new_or_returning = 'returning';
    const env = makeEnv(state, '600111222');
    const result = await handleBookingEntryGate(env);
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.result.message.content).toBe(ENTRY_BOOKING_RETURNING_AMBIGUOUS);
      expect((state.metadata as Record<string, unknown>).booking_patient_status_pending).toBe(false);
    }
  });

  // ==========================================================================
  // 10. Invalid phone re-asks
  // ==========================================================================

  test('returning + invalid phone input re-asks for phone', async () => {
    const state = makeState();
    (state.metadata as Record<string, unknown>).booking_returning_awaiting_phone = true;
    state.patient.new_or_returning = 'returning';
    const env = makeEnv(state, 'no tengo teléfono');
    const result = await handleBookingEntryGate(env);
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.result.message.content).toBe(ENTRY_BOOKING_RETURNING_ASK_PHONE);
    }
  });

  // ==========================================================================
  // 11. Gate only runs on active flag
  // ==========================================================================

  test('gate does not run on second turn when flag was already cleared', async () => {
    const state = makeState();
    (state.metadata as Record<string, unknown>).booking_patient_status_pending = false;
    (state.metadata as Record<string, unknown>).entry_detected_at = new Date().toISOString();
    const env = makeEnv(state, 'anything');
    const result = await handleBookingEntryGate(env);
    expect(result.handled).toBe(false);
  });

  // ==========================================================================
  // 12. Confirmation priority (regression)
  // ==========================================================================

  test('awaiting_confirmation state is not affected by gate flag', async () => {
    // The gate is called BEFORE confirmation in process-chat-turn.ts.
    // But when awaiting_confirmation is true, the confirmation gate
    // takes priority because booking_patient_status_pending should
    // never be true at the same time (it's cleared before confirmation
    // can be reached). This test verifies the gate's own behavior:
    // it only cares about booking_patient_status_pending.
    const state = makeState();
    state.awaiting_confirmation = true;
    state.pending_appointment = { service_type: 'limpieza', preferred_date: 'mañana', preferred_time: 'morning', preferred_provider: null, flexibility: null };
    (state.metadata as Record<string, unknown>).booking_patient_status_pending = false;
    const env = makeEnv(state, 'sí');
    const result = await handleBookingEntryGate(env);
    // Gate does not interfere — flag is off
    expect(result.handled).toBe(false);
  });
});
