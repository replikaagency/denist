import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Conversation } from '@/types/database';
import { getContactById } from '@/lib/db/contacts';
import { createInitialState } from '@/lib/conversation/schema';
import * as conversationService from './conversation.service';
import * as appointmentService from './appointment.service';
import * as engine from '@/lib/conversation/engine';
import { callLLM } from '@/lib/ai/completion';
import { processChatMessage } from './chat.service';

vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
const getMissingFieldsMock = vi.fn(() => []);
const getNextFieldPromptMock = vi.fn(() => null);

const insertMessageMock = vi.fn();
vi.mock('@/lib/db/messages', () => ({
  insertMessage: (input: unknown) => insertMessageMock(input),
  getRecentMessages: () => Promise.resolve([]),
}));

vi.mock('@/lib/db/conversations', () => ({
  updateConversation: vi.fn(),
}));

vi.mock('@/lib/db/contacts', () => ({
  getContactById: vi.fn(),
}));

vi.mock('@/lib/db/conversation-events', () => ({
  appendConversationEvent: vi.fn(),
}));

vi.mock('@/lib/db/hybrid-bookings', () => ({
  getActiveHybridBookingForConversation: () => Promise.resolve(null),
}));

vi.mock('./contact.service', () => ({
  enrichContact: () => Promise.resolve(null),
}));

vi.mock('./lead.service', () => ({
  ensureLead: () => Promise.resolve({ id: 'lead1', status: 'new' }),
}));

vi.mock('./handoff.service', () => ({
  createHandoff: vi.fn(),
}));

vi.mock('./hybrid-booking.service', () => ({
  processHybridBookingTurn: () =>
    Promise.resolve({ deferredStandardFlow: false }),
  appendHybridAckToReply: (s: string) => s,
  mergeAvailabilityCaptureReply: (a: string) => a,
  mergeDirectBookingChoiceReply: (a: string) => a,
  mergeHybridOfferTwoWaysReply: (a: string) => a,
}));

vi.mock('./appointment.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./appointment.service')>();
  return {
    ...mod,
    createRequest: vi.fn(),
    findOpenAppointmentRequest: vi.fn(() => Promise.resolve(null)),
    findOpenRequestsForContact: vi.fn(() => Promise.resolve([])),
    executeReschedule: vi.fn(),
  };
});

vi.mock('./conversation.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./conversation.service')>();
  return {
    ...mod,
    verifyOwnership: vi.fn(),
    loadState: vi.fn(),
    saveState: vi.fn(),
    touch: vi.fn(),
    getConversationById: vi.fn(),
  };
});

vi.mock('@/lib/ai/completion', () => ({
  callLLM: vi.fn(),
}));

vi.mock('@/lib/conversation/prompts', () => ({
  buildSystemPrompt: () => '',
  getClinicConfig: () => ({}),
  FEW_SHOT_BY_INTENT: {},
}));

vi.mock('@/lib/conversation/fields', () => ({
  getMissingFields: (...args: unknown[]) => getMissingFieldsMock(...args),
  getNextFieldPrompt: (...args: unknown[]) => getNextFieldPromptMock(...args),
}));

vi.mock('@/lib/conversation/engine', () => ({
  processTurn: vi.fn(() => ({ error: 'forced-test-parse-error' })),
}));

const mockConv: Conversation = {
  id: 'conv1',
  contact_id: 'cont1',
  status: 'active',
  ai_enabled: true,
  metadata: {},
  last_message_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  channel: 'web',
  session_id: null,
  lead_id: null,
  summary: null,
} as unknown as Conversation;

describe('processChatMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMissingFieldsMock.mockReset();
    getMissingFieldsMock.mockReturnValue([]);
    getNextFieldPromptMock.mockReset();
    getNextFieldPromptMock.mockReturnValue(null);
    let msgSeq = 0;
    insertMessageMock.mockImplementation(async (input: { role: string; content: string; conversation_id: string }) => ({
      id: `msg-${++msgSeq}`,
      conversation_id: input.conversation_id,
      role: input.role,
      content: input.content,
      created_at: new Date().toISOString(),
    }));

    vi.mocked(conversationService.verifyOwnership).mockResolvedValue(mockConv);
    vi.mocked(conversationService.touch).mockResolvedValue(undefined);
    vi.mocked(conversationService.getConversationById).mockResolvedValue(mockConv);
    vi.mocked(conversationService.saveState).mockImplementation(async (_id, state) => ({
      ...mockConv,
      metadata: { conversation_state: state },
    }));

    vi.mocked(getContactById).mockResolvedValue({
      id: 'cont1',
      session_token: 'sess1',
      first_name: 'Ana',
      last_name: null,
      phone: '+34111222333',
      email: null,
      created_at: '',
      updated_at: '',
    } as Awaited<ReturnType<typeof getContactById>>);

    vi.mocked(appointmentService.createRequest).mockResolvedValue({
      id: 'ar1',
      conversation_id: 'conv1',
      contact_id: 'cont1',
      lead_id: 'lead1',
      status: 'pending',
      appointment_type: 'other',
    } as Awaited<ReturnType<typeof appointmentService.createRequest>>);
    vi.mocked(appointmentService.findOpenRequestsForContact).mockResolvedValue([]);

    vi.mocked(callLLM).mockResolvedValue({
      text: 'not-valid-json',
      model: 'test',
      tokensUsed: 0,
      latencyMs: 0,
      finishReason: 'stop',
    });
  });

  it('creates exactly one appointment request when patient confirms with sí (complete pending snapshot)', async () => {
    const state = createInitialState('conv1');
    state.awaiting_confirmation = true;
    state.pending_appointment = {
      service_type: 'cleaning',
      preferred_date: '2026-06-15',
      preferred_time: 'morning',
      preferred_provider: null,
      flexibility: null,
    };
    state.confirmation_prompt_at = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    vi.mocked(conversationService.loadState).mockResolvedValue(state);

    await processChatMessage({
      session_token: 'sess1',
      conversation_id: 'conv1',
      content: 'sí',
    });

    expect(appointmentService.createRequest).toHaveBeenCalledTimes(1);
    expect(appointmentService.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv1',
        contactId: 'cont1',
        leadId: 'lead1',
      }),
    );

    const saveCalls = vi.mocked(conversationService.saveState).mock.calls;
    const finalState = saveCalls[saveCalls.length - 1][1];
    expect(finalState.awaiting_confirmation).toBe(false);
    expect(finalState.pending_appointment).toBeNull();
    expect(finalState.confirmation_prompt_at).toBeNull();
    expect(finalState.appointment_request_open).toBe(true);
    expect(finalState.completed).toBe(true);

    expect(callLLM).not.toHaveBeenCalled();
    const confirmationInsert = insertMessageMock.mock.calls.find(
      ([payload]) => payload?.role === 'ai' && payload?.metadata?.type === 'optional_email_choice',
    )?.[0];
    expect(confirmationInsert?.metadata?.options).toEqual([
      { label: 'Añadir correo', value: 'email_add_yes' },
      { label: 'No, gracias', value: 'email_add_no' },
    ]);
  });

  it('expires stale confirmation and does not create a request from sí; continues to LLM flow', async () => {
    const state = createInitialState('conv1');
    state.awaiting_confirmation = true;
    state.pending_appointment = {
      service_type: 'cleaning',
      preferred_date: '2026-06-15',
      preferred_time: 'morning',
      preferred_provider: null,
      flexibility: null,
    };
    state.confirmation_prompt_at = new Date(Date.now() - 31 * 60 * 1000).toISOString();

    vi.mocked(conversationService.loadState).mockResolvedValue(state);

    await processChatMessage({
      session_token: 'sess1',
      conversation_id: 'conv1',
      content: 'sí',
    });

    expect(appointmentService.createRequest).not.toHaveBeenCalled();
    expect(callLLM).toHaveBeenCalled();

    const saveCalls = vi.mocked(conversationService.saveState).mock.calls;
    const finalState = saveCalls[saveCalls.length - 1][1];
    expect(finalState.awaiting_confirmation).toBe(false);
    expect(finalState.pending_appointment).toBeNull();
    expect(finalState.confirmation_prompt_at).toBeNull();
  });

  it('returns correction_choice metadata on confirm_change path', async () => {
    const state = createInitialState('conv1');
    state.awaiting_confirmation = true;
    state.pending_appointment = {
      service_type: 'cleaning',
      preferred_date: '2026-06-15',
      preferred_time: 'morning',
      preferred_provider: null,
      flexibility: null,
    };
    state.confirmation_prompt_at = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    vi.mocked(conversationService.loadState).mockResolvedValue(state);

    await processChatMessage({
      session_token: 'sess1',
      conversation_id: 'conv1',
      content: 'confirm_change',
    });

    const aiInsert = insertMessageMock.mock.calls.find(
      ([payload]) => payload?.role === 'ai' && payload?.metadata?.type === 'correction_choice',
    )?.[0];

    expect(aiInsert).toBeTruthy();
    expect(aiInsert.metadata).toMatchObject({
      type: 'correction_choice',
      path: 'confirmation_intercept',
      options: [
        { label: 'Cambiar fecha', value: 'change_date' },
        { label: 'Cambiar hora', value: 'change_time' },
        { label: 'Cambiar servicio', value: 'change_service' },
      ],
    });
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('adds patient_status_choice metadata by flow state, not exact reply text', async () => {
    const state = createInitialState('conv1');
    state.current_intent = 'appointment_request';
    state.patient.full_name = 'Ana Perez';
    state.patient.phone = '+34111222333';
    state.appointment.service_type = 'limpieza';
    state.appointment.preferred_date = '2026-06-20';
    state.appointment.preferred_time = 'morning';

    vi.mocked(conversationService.loadState).mockResolvedValue(state);
    getMissingFieldsMock.mockReturnValue(['patient.new_or_returning']);

    const turnState = createInitialState('conv1');
    turnState.current_intent = 'appointment_request';
    turnState.patient.full_name = 'Ana Perez';
    turnState.patient.phone = '+34111222333';
    turnState.patient.new_or_returning = null;
    turnState.appointment.service_type = 'limpieza';
    turnState.appointment.preferred_date = '2026-06-20';
    turnState.appointment.preferred_time = 'morning';

    vi.mocked(engine.processTurn).mockReturnValue({
      reply: 'Seguimos con tus datos para reservar.',
      state: turnState,
      escalation: { shouldEscalate: false, reason: null, type: null },
      fallback: { applied: false, rewrittenReply: null, reason: null },
      flowValidation: {
        stage: 'collecting',
        overridden: false,
        originalAction: 'ask_field',
        correctedAction: 'ask_field',
        correctedReply: null,
        reason: null,
      },
      rawOutput: {
        intent: 'appointment_request',
        intent_confidence: 0.95,
        urgency: 'routine',
        urgency_reasoning: null,
        patient_fields: {},
        appointment: {},
        symptoms: {},
        is_correction: false,
        correction_fields: [],
        missing_fields: ['patient.new_or_returning'],
        needs_clarification: false,
        clarification_question: null,
        contains_diagnosis: false,
        contains_pricing: false,
        escalation_reason: null,
        next_action: 'ask_field',
        reply: 'Texto distinto al wording anterior.',
      },
    });

    await processChatMessage({
      session_token: 'sess1',
      conversation_id: 'conv1',
      content: 'hola',
    });

    const aiInsert = insertMessageMock.mock.calls.find(
      ([payload]) => payload?.role === 'ai' && payload?.model === 'test',
    )?.[0];

    expect(aiInsert).toBeTruthy();
    expect(aiInsert.metadata).toMatchObject({
      type: 'patient_status_choice',
      field: 'new_or_returning',
      options: [
        { label: 'Es mi primera vez', value: 'patient_status_new' },
        { label: 'Ya he venido antes', value: 'patient_status_returning' },
      ],
    });
  });

  it('adds time_preference_choice metadata by flow state, not exact reply text', async () => {
    const state = createInitialState('conv1');
    state.current_intent = 'appointment_request';
    state.patient.full_name = 'Ana Perez';
    state.patient.phone = '+34111222333';
    state.patient.new_or_returning = 'new';
    state.appointment.service_type = 'limpieza';
    state.appointment.preferred_date = '2026-06-20';

    vi.mocked(conversationService.loadState).mockResolvedValue(state);
    getMissingFieldsMock.mockReturnValue(['appointment.preferred_time']);

    const turnState = createInitialState('conv1');
    turnState.current_intent = 'appointment_request';
    turnState.patient.full_name = 'Ana Perez';
    turnState.patient.phone = '+34111222333';
    turnState.patient.new_or_returning = 'new';
    turnState.appointment.service_type = 'limpieza';
    turnState.appointment.preferred_date = '2026-06-20';
    turnState.appointment.preferred_time = null;

    vi.mocked(engine.processTurn).mockReturnValue({
      reply: '¿Qué horario prefieres?',
      state: turnState,
      escalation: { shouldEscalate: false, reason: null, type: null },
      fallback: { applied: false, rewrittenReply: null, reason: null },
      flowValidation: {
        stage: 'collecting',
        overridden: false,
        originalAction: 'ask_field',
        correctedAction: 'ask_field',
        correctedReply: null,
        reason: null,
      },
      rawOutput: {
        intent: 'appointment_request',
        intent_confidence: 0.95,
        urgency: 'routine',
        urgency_reasoning: null,
        patient_fields: {},
        appointment: {},
        symptoms: {},
        is_correction: false,
        correction_fields: [],
        missing_fields: ['appointment.preferred_time'],
        needs_clarification: false,
        clarification_question: null,
        contains_diagnosis: false,
        contains_pricing: false,
        escalation_reason: null,
        next_action: 'ask_field',
        reply: 'Texto cualquiera.',
      },
    });

    await processChatMessage({
      session_token: 'sess1',
      conversation_id: 'conv1',
      content: 'hola',
    });

    const aiInsert = insertMessageMock.mock.calls.find(
      ([payload]) => payload?.role === 'ai' && payload?.model === 'test',
    )?.[0];

    expect(aiInsert).toBeTruthy();
    expect(aiInsert.metadata).toMatchObject({
      type: 'time_preference_choice',
      field: 'preferred_time',
      options: [
        { label: 'Mañana', value: 'time_morning' },
        { label: 'Tarde', value: 'time_afternoon' },
        { label: 'Hora concreta', value: 'time_exact' },
      ],
    });
  });

  it('adds request_selection metadata when multiple reschedule targets exist', async () => {
    const state = createInitialState('conv1');
    state.current_intent = 'appointment_reschedule';

    vi.mocked(conversationService.loadState).mockResolvedValue(state);
    vi.mocked(appointmentService.findOpenRequestsForContact).mockResolvedValue([
      {
        id: 'req-1',
        appointment_type: 'cleaning',
        preferred_date: '2026-07-01',
        preferred_time_of_day: 'morning',
        status: 'pending',
      },
      {
        id: 'req-2',
        appointment_type: 'ortodoncia',
        preferred_date: '2026-07-03',
        preferred_time_of_day: 'afternoon',
        status: 'pending',
      },
    ] as Awaited<ReturnType<typeof appointmentService.findOpenRequestsForContact>>);

    const turnState = createInitialState('conv1');
    turnState.current_intent = 'appointment_reschedule';
    turnState.reschedule_phase = 'idle';

    vi.mocked(engine.processTurn).mockReturnValue({
      reply: 'Vamos a revisar cuál quieres cambiar.',
      state: turnState,
      escalation: { shouldEscalate: false, reason: null, type: null },
      fallback: { applied: false, rewrittenReply: null, reason: null },
      flowValidation: {
        stage: 'collecting',
        overridden: false,
        originalAction: 'continue',
        correctedAction: 'continue',
        correctedReply: null,
        reason: null,
      },
      rawOutput: {
        intent: 'appointment_reschedule',
        intent_confidence: 0.95,
        urgency: 'routine',
        urgency_reasoning: null,
        patient_fields: {},
        appointment: {},
        symptoms: {},
        is_correction: false,
        correction_fields: [],
        missing_fields: [],
        needs_clarification: false,
        clarification_question: null,
        contains_diagnosis: false,
        contains_pricing: false,
        escalation_reason: null,
        next_action: 'continue',
        reply: 'Texto libre.',
      },
    });

    await processChatMessage({
      session_token: 'sess1',
      conversation_id: 'conv1',
      content: 'quiero cambiar una cita',
    });

    const aiInsert = insertMessageMock.mock.calls.find(
      ([payload]) => payload?.role === 'ai' && payload?.model === 'test',
    )?.[0];

    expect(aiInsert).toBeTruthy();
    expect(aiInsert.metadata?.type).toBe('request_selection');
    expect(aiInsert.metadata?.options).toEqual([
      expect.objectContaining({ value: 'req-1' }),
      expect.objectContaining({ value: 'req-2' }),
    ]);
  });

  it('maps selected request id deterministically in selecting_target phase', async () => {
    const state = createInitialState('conv1');
    state.reschedule_phase = 'selecting_target';
    state.metadata = {
      ...state.metadata,
      reschedule_options: [
        { id: 'req-1', summary: 'Limpieza — 2026-07-01 — por la mañana' },
        { id: 'req-2', summary: 'Ortodoncia — 2026-07-03 — por la tarde' },
      ],
      reschedule_options_count: 2,
    };

    vi.mocked(conversationService.loadState).mockResolvedValue(state);

    await processChatMessage({
      session_token: 'sess1',
      conversation_id: 'conv1',
      content: 'req-2',
    });

    const targetLockedInsert = insertMessageMock.mock.calls.find(
      ([payload]) => payload?.role === 'ai' && payload?.metadata?.type === 'reschedule_target_locked',
    )?.[0];

    expect(targetLockedInsert).toBeTruthy();
    expect(targetLockedInsert.metadata?.target_id).toBe('req-2');
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('uses targeted re-ask prompt on parse fallback during active booking', async () => {
    const state = createInitialState('conv1');
    state.current_intent = 'appointment_request';
    state.patient.full_name = 'Ana Perez';
    state.patient.phone = '+34111222333';
    state.patient.new_or_returning = 'new';
    state.appointment.service_type = null;
    state.appointment.preferred_date = '2026-07-10';
    state.appointment.preferred_time = 'morning';

    vi.mocked(conversationService.loadState).mockResolvedValue(state);
    getNextFieldPromptMock.mockReturnValue({
      field: 'appointment.service_type',
      prompt: '¿Para qué tipo de tratamiento quieres la cita? ¿Una limpieza, revisión, o algo distinto?',
    });
    vi.mocked(engine.processTurn).mockReturnValue({ error: 'forced-test-parse-error' } as ReturnType<typeof engine.processTurn>);

    await processChatMessage({
      session_token: 'sess1',
      conversation_id: 'conv1',
      content: 'blabla',
    });

    const parseFallbackInsert = insertMessageMock.mock.calls
      .map(([payload]) => payload)
      .find(
        (payload) =>
          payload?.role === 'ai' &&
          typeof payload?.content === 'string' &&
          payload.content.includes('¿Para qué tipo de tratamiento quieres la cita?'),
      );
    expect(parseFallbackInsert).toBeTruthy();
    expect(parseFallbackInsert.content).toContain('¿Para qué tipo de tratamiento quieres la cita?');
    expect(parseFallbackInsert.metadata).toMatchObject({
      type: 'service_choice_fallback',
      field: 'service_type',
    });
  });

  it('answers side question and returns to next booking step', async () => {
    const state = createInitialState('conv1');
    state.current_intent = 'appointment_request';
    state.patient.full_name = 'Ana Perez';
    state.patient.phone = '+34111222333';
    state.patient.new_or_returning = 'new';
    state.appointment.service_type = 'limpieza';
    state.appointment.preferred_date = null;
    state.appointment.preferred_time = null;

    vi.mocked(conversationService.loadState).mockResolvedValue(state);
    getMissingFieldsMock.mockReturnValue(['appointment.preferred_date']);
    getNextFieldPromptMock.mockReturnValue({
      field: 'appointment.preferred_date',
      prompt: '¿Qué día te vendría mejor?',
    });
    vi.mocked(engine.processTurn).mockReturnValue({
      reply: 'La limpieza suele tener un precio orientativo según valoración inicial.',
      state,
      escalation: { shouldEscalate: false, reason: null, type: null },
      fallback: { applied: false, rewrittenReply: null, reason: null },
      flowValidation: {
        stage: 'collecting',
        overridden: false,
        originalAction: 'continue',
        correctedAction: 'continue',
        correctedReply: null,
        reason: null,
      },
      rawOutput: {
        intent: 'appointment_request',
        intent_confidence: 0.95,
        urgency: 'routine',
        urgency_reasoning: null,
        patient_fields: {},
        appointment: {},
        symptoms: {},
        is_correction: false,
        correction_fields: [],
        missing_fields: ['appointment.preferred_date'],
        needs_clarification: false,
        clarification_question: null,
        contains_diagnosis: false,
        contains_pricing: false,
        escalation_reason: null,
        next_action: 'continue',
        reply: 'La limpieza suele tener un precio orientativo según valoración inicial.',
      },
    });

    await processChatMessage({
      session_token: 'sess1',
      conversation_id: 'conv1',
      content: '¿Cuánto cuesta?',
    });

    const aiInsert = insertMessageMock.mock.calls.find(
      ([payload]) => payload?.role === 'ai' && payload?.model === 'test',
    )?.[0];
    expect(aiInsert).toBeTruthy();
    expect(aiInsert.content).toContain('Si quieres, seguimos con tu solicitud');
    expect(aiInsert.content).toContain('¿Qué día te vendría mejor?');
  });

  it('uses patient-status buttons on guided fallback when missing patient status', async () => {
    const state = createInitialState('conv1');
    state.current_intent = 'appointment_request';
    state.patient.full_name = 'Ana Perez';
    state.patient.phone = '+34111222333';
    state.patient.new_or_returning = null;
    state.appointment.service_type = 'limpieza';
    state.appointment.preferred_date = 'martes';
    state.appointment.preferred_time = 'morning';

    vi.mocked(conversationService.loadState).mockResolvedValue(state);
    getNextFieldPromptMock.mockReturnValue({
      field: 'patient.new_or_returning',
      prompt: '¿Es la primera vez que vienes a la clínica o ya eres paciente nuestro/a?',
    });
    vi.mocked(engine.processTurn).mockReturnValue({ error: 'forced-test-parse-error' } as ReturnType<typeof engine.processTurn>);

    await processChatMessage({
      session_token: 'sess1',
      conversation_id: 'conv1',
      content: 'no entiendo',
    });

    const guidedInsert = insertMessageMock.mock.calls
      .map(([payload]) => payload)
      .find((payload) => payload?.role === 'ai' && payload?.metadata?.type === 'patient_status_choice');
    expect(guidedInsert).toBeTruthy();
    expect(guidedInsert.content).toContain('¿Es la primera vez');
  });

  it('uses service fallback buttons when missing service in guided fallback', async () => {
    const state = createInitialState('conv1');
    state.current_intent = 'appointment_request';
    state.patient.full_name = 'Ana Perez';
    state.patient.phone = '+34111222333';
    state.patient.new_or_returning = 'new';
    state.appointment.service_type = null;
    state.appointment.preferred_date = null;
    state.appointment.preferred_time = null;

    vi.mocked(conversationService.loadState).mockResolvedValue(state);
    getNextFieldPromptMock.mockReturnValue({
      field: 'appointment.service_type',
      prompt: '¿Para qué tipo de tratamiento quieres la cita? ¿Una limpieza, revisión, o algo distinto?',
    });
    vi.mocked(engine.processTurn).mockReturnValue({ error: 'forced-test-parse-error' } as ReturnType<typeof engine.processTurn>);

    await processChatMessage({
      session_token: 'sess1',
      conversation_id: 'conv1',
      content: 'no entiendo',
    });

    const guidedInsert = insertMessageMock.mock.calls
      .map(([payload]) => payload)
      .find((payload) => payload?.role === 'ai' && payload?.metadata?.type === 'service_choice_fallback');
    expect(guidedInsert).toBeTruthy();
    expect(guidedInsert.metadata.options).toEqual([
      { label: 'Limpieza', value: 'service_cleaning' },
      { label: 'Revisión', value: 'service_checkup' },
      { label: 'Ortodoncia', value: 'service_ortho' },
    ]);
  });

  it('enters quick booking flow and asks next required field', async () => {
    const state = createInitialState('conv1');
    state.current_intent = null;
    state.patient.full_name = null;
    state.patient.phone = null;
    state.patient.new_or_returning = null;
    state.appointment.service_type = null;
    state.appointment.preferred_date = null;
    state.appointment.preferred_time = null;

    vi.mocked(conversationService.loadState).mockResolvedValue(state);
    getNextFieldPromptMock.mockReturnValue({
      field: 'patient.full_name',
      prompt: '¿Me dices tu nombre completo?',
    });

    await processChatMessage({
      session_token: 'sess1',
      conversation_id: 'conv1',
      content: 'quick_booking_start',
    });

    const quickInsert = insertMessageMock.mock.calls
      .map(([payload]) => payload)
      .find((payload) => payload?.role === 'ai' && payload?.metadata?.type === 'quick_booking_entry');
    expect(quickInsert).toBeTruthy();
    expect(quickInsert.content).toContain('¿Me dices tu nombre completo?');
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('shows fast booking path choice when self-service URL is configured', async () => {
    const prevSelfServiceUrl = process.env.BOOKING_SELF_SERVICE_URL;
    process.env.BOOKING_SELF_SERVICE_URL = 'https://cal.example.com/book';
    const state = createInitialState('conv1');
    state.current_intent = null;
    vi.mocked(conversationService.loadState).mockResolvedValue(state);

    await processChatMessage({
      session_token: 'sess1',
      conversation_id: 'conv1',
      content: 'quick_booking_fast',
    });

    const quickChoiceInsert = insertMessageMock.mock.calls
      .map(([payload]) => payload)
      .find((payload) => payload?.role === 'ai' && payload?.metadata?.type === 'quick_booking_path_choice');
    expect(quickChoiceInsert).toBeTruthy();
    expect(quickChoiceInsert.metadata?.options).toEqual([
      { label: 'Elegir hora directamente', value: 'quick_path_direct' },
      { label: 'Prefiero que recepción me contacte', value: 'quick_path_reception' },
    ]);
    expect(callLLM).not.toHaveBeenCalled();
    process.env.BOOKING_SELF_SERVICE_URL = prevSelfServiceUrl;
  });

  it('routes fast booking directly to request capture when self-service URL is missing', async () => {
    const prevSelfServiceUrl = process.env.BOOKING_SELF_SERVICE_URL;
    delete process.env.BOOKING_SELF_SERVICE_URL;
    const state = createInitialState('conv1');
    state.current_intent = null;
    vi.mocked(conversationService.loadState).mockResolvedValue(state);
    getNextFieldPromptMock.mockReturnValue({
      field: 'patient.new_or_returning',
      prompt: '¿Es la primera vez que vienes a la clínica o ya eres paciente nuestro/a?',
    });

    await processChatMessage({
      session_token: 'sess1',
      conversation_id: 'conv1',
      content: 'quick_booking_fast',
    });

    const quickChoiceInsert = insertMessageMock.mock.calls
      .map(([payload]) => payload)
      .find((payload) => payload?.role === 'ai' && payload?.metadata?.type === 'quick_booking_path_choice');
    expect(quickChoiceInsert).toBeFalsy();
    const quickInsert = insertMessageMock.mock.calls
      .map(([payload]) => payload)
      .find((payload) => payload?.role === 'ai' && payload?.metadata?.type === 'patient_status_choice');
    expect(quickInsert).toBeTruthy();
    expect(callLLM).not.toHaveBeenCalled();
    process.env.BOOKING_SELF_SERVICE_URL = prevSelfServiceUrl;
  });

  it('hydrates patient identity from contact to avoid re-asking full_name/phone', async () => {
    const state = createInitialState('conv1');
    state.current_intent = null;
    state.patient.full_name = null;
    state.patient.phone = null;
    state.patient.new_or_returning = null;
    vi.mocked(conversationService.loadState).mockResolvedValue(state);
    getNextFieldPromptMock.mockImplementation((_intent, filledFields) => {
      const patient = (filledFields as { patient: { full_name: string | null; phone: string | null } }).patient;
      expect(patient.full_name).toBe('Ana');
      expect(patient.phone).toBe('+34111222333');
      return {
        field: 'patient.new_or_returning',
        prompt: '¿Es la primera vez que vienes a la clínica o ya eres paciente nuestro/a?',
      };
    });

    await processChatMessage({
      session_token: 'sess1',
      conversation_id: 'conv1',
      content: 'quick_booking_start',
    });

    const quickInsert = insertMessageMock.mock.calls
      .map(([payload]) => payload)
      .find((payload) => payload?.role === 'ai' && payload?.metadata?.type === 'patient_status_choice');
    expect(quickInsert).toBeTruthy();
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('routes quick_path_direct safely to request capture when self-service URL is missing', async () => {
    const prevSelfServiceUrl = process.env.BOOKING_SELF_SERVICE_URL;
    delete process.env.BOOKING_SELF_SERVICE_URL;
    const state = createInitialState('conv1');
    state.current_intent = 'appointment_request';
    vi.mocked(conversationService.loadState).mockResolvedValue(state);
    getNextFieldPromptMock.mockReturnValue({
      field: 'patient.new_or_returning',
      prompt: '¿Es la primera vez que vienes a la clínica o ya eres paciente nuestro/a?',
    });

    await processChatMessage({
      session_token: 'sess1',
      conversation_id: 'conv1',
      content: 'quick_path_direct',
    });

    const quickInsert = insertMessageMock.mock.calls
      .map(([payload]) => payload)
      .find((payload) => payload?.role === 'ai' && payload?.metadata?.type === 'patient_status_choice');
    expect(quickInsert).toBeTruthy();
    expect(callLLM).not.toHaveBeenCalled();
    process.env.BOOKING_SELF_SERVICE_URL = prevSelfServiceUrl;
  });

  it('does not enter quick booking while reschedule flow is active', async () => {
    const state = createInitialState('conv1');
    state.current_intent = 'appointment_reschedule';
    state.reschedule_phase = 'collecting_new_details';
    state.reschedule_target_id = 'req-1';
    state.reschedule_target_summary = 'Limpieza — 2026-07-01 — por la mañana';

    vi.mocked(conversationService.loadState).mockResolvedValue(state);

    await processChatMessage({
      session_token: 'sess1',
      conversation_id: 'conv1',
      content: 'quick_booking_start',
    });

    const quickInsert = insertMessageMock.mock.calls
      .map(([payload]) => payload)
      .find((payload) => payload?.role === 'ai' && payload?.metadata?.type === 'quick_booking_entry');
    expect(quickInsert).toBeFalsy();
    expect(callLLM).toHaveBeenCalled();
  });

});
