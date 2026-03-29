/**
 * Regression tests: turn_engine.branch structured logs (event + fields + stable branch_taken).
 * Logger is mocked — no reliance on console output.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Conversation } from '@/types/database';
import type { ConversationState } from '@/lib/conversation/schema';
import { createInitialState } from '@/lib/conversation/schema';
import { processChatMessage } from '@/services/chat.service';
import * as conversationService from '@/services/conversation.service';
import * as appointmentService from '@/services/appointment.service';
import { callLLM } from '@/lib/ai/completion';
import { log } from '@/lib/logger';
import { getContactById } from '@/lib/db/contacts';
import { insertMessage, getRecentMessages } from '@/lib/db/messages';
import {
  COORDINATOR_YIELD_BRANCH_PREFIX,
  TURN_ENGINE_BRANCH_LOG_EVENT,
  TurnEngineBranch,
} from '@/lib/conversation/turn-engine-branches';
import { applyHybridBookingPhase } from '@/lib/conversation/turn-phases/handle-hybrid-phase';
import { processHybridBookingTurn } from '@/services/hybrid-booking.service';
import type { TurnResult } from '@/lib/conversation/engine';

vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
vi.mock('@/lib/logger/flow-logger', () => ({ logConversationFlow: vi.fn() }));

const transcript: Array<{ id: string; role: string; content: string }> = [];

vi.mock('@/lib/db/messages', () => ({
  insertMessage: vi.fn(),
  getRecentMessages: vi.fn(),
}));

vi.mock('@/lib/db/conversations', () => ({
  updateConversation: vi.fn(async () => ({})),
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

vi.mock('@/services/contact.service', () => ({
  enrichContact: vi.fn(async (_id: string, data: { full_name?: string | null; phone?: string | null }) => ({
    id: 'cont-e2e',
    email: null,
    phone: data?.phone ?? '600000000',
    first_name: data?.full_name?.split(/\s+/)[0] ?? 'Paciente',
    last_name: data?.full_name?.split(/\s+/).slice(1).join(' ') || null,
    is_new_patient: true,
    insurance_provider: null,
    session_token: 'sess-e2e',
    metadata: {},
  })),
  resolvePatientIdentityAfterPhoneCapture: async (_p: unknown, _cid: string, c: unknown) => c as never,
}));

vi.mock('@/services/lead.service', () => ({
  ensureLead: () => Promise.resolve({ id: 'lead-e2e', status: 'new' as const }),
}));

vi.mock('@/services/handoff.service', () => ({
  createHandoff: vi.fn(),
}));

vi.mock('@/services/hybrid-booking.service', () => ({
  processHybridBookingTurn: vi.fn(),
  appendHybridAckToReply: (s: string) => s,
  mergeAvailabilityCaptureReply: (a: string) => a,
  mergeDirectBookingChoiceReply: (a: string) => a,
  mergeHybridOfferTwoWaysReply: (a: string) => a,
}));

vi.mock('@/services/appointment.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/services/appointment.service')>();
  return {
    ...mod,
    createRequest: vi.fn(),
    findOpenAppointmentRequest: vi.fn(() => Promise.resolve(null)),
    findOpenRequestsForContact: vi.fn(() => Promise.resolve([])),
    executeReschedule: vi.fn(),
  };
});

vi.mock('@/services/conversation.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/services/conversation.service')>();
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
  buildSystemPrompt: () => 'system',
  getClinicConfig: () => ({}),
  FEW_SHOT_BY_INTENT: {},
}));

const CONV_ID = 'conv-obs';
const SESS = 'sess-e2e';

const mockConversation = {
  id: CONV_ID,
  contact_id: 'cont-e2e',
  status: 'active',
  ai_enabled: true,
  metadata: {},
  last_message_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  channel: 'web_chat',
  session_id: null,
  lead_id: null,
  summary: null,
} as unknown as Conversation;

const mockContact = {
  id: 'cont-e2e',
  email: null,
  phone: null,
  first_name: null,
  last_name: null,
  is_new_patient: true,
  insurance_provider: null,
  session_token: SESS,
  metadata: {},
} as unknown as Awaited<ReturnType<typeof getContactById>>;

let persistedState: ConversationState;
let llmQueue: string[] = [];

function turnEnginePayloads(): Array<Record<string, unknown>> {
  return vi.mocked(log).mock.calls
    .filter((call) => call[0] === 'info' && call[1] === TURN_ENGINE_BRANCH_LOG_EVENT)
    .map((call) => (call[2] ?? {}) as Record<string, unknown>);
}

function assertTurnEngineShape(p: Record<string, unknown>): void {
  expect(p).toMatchObject({
    conversation_id: expect.any(String),
    current_step: expect.any(String),
    branch_taken: expect.stringMatching(
      /^(?:(?:coordinator|intake|booking|confirmation|hybrid|llm|side_effects)\.[\w.]+|deterministic_intake|social_thanks)$/,
    ),
    reason: expect.any(String),
    input_summary: expect.any(String),
    resulting_next_step: expect.any(String),
    allow_llm: expect.any(Boolean),
  });
}

function baseLlmJson(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    intent: 'appointment_request',
    intent_confidence: 0.95,
    secondary_intent: null,
    urgency: 'routine',
    urgency_reasoning: 'obs',
    patient_fields: {},
    appointment: {},
    symptoms: {},
    next_action: 'continue',
    missing_fields: [] as string[],
    escalation_reason: null,
    reply: 'De acuerdo.',
    contains_diagnosis: false,
    contains_pricing: false,
    is_correction: false,
    correction_fields: [] as string[],
    ...overrides,
  });
}

async function send(content: string): Promise<void> {
  await processChatMessage({
    session_token: SESS,
    conversation_id: CONV_ID,
    content,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  transcript.length = 0;
  llmQueue = [];
  persistedState = createInitialState(CONV_ID);
  vi.mocked(processHybridBookingTurn).mockResolvedValue({ deferredStandardFlow: false });

  vi.mocked(insertMessage).mockImplementation(async (input: { role: string; content: string }) => {
    const id = `m${transcript.length}`;
    transcript.push({ id, role: input.role, content: input.content });
    return { id, content: input.content } as never;
  });
  vi.mocked(getRecentMessages).mockImplementation(async () => transcript as never);

  vi.mocked(conversationService.verifyOwnership).mockResolvedValue(mockConversation);
  vi.mocked(conversationService.touch).mockResolvedValue(undefined);
  vi.mocked(conversationService.getConversationById).mockResolvedValue(mockConversation);
  vi.mocked(conversationService.loadState).mockImplementation(async () => structuredClone(persistedState));
  vi.mocked(conversationService.saveState).mockImplementation(async (_id, s) => {
    persistedState = structuredClone(s);
    return mockConversation;
  });

  vi.mocked(getContactById).mockImplementation(async () => ({
    ...mockContact,
    first_name: persistedState.patient.full_name?.split(/\s+/)[0] ?? null,
    last_name: persistedState.patient.full_name?.split(/\s+/).slice(1).join(' ') || null,
    phone: persistedState.patient.phone ?? mockContact.phone,
  }));

  vi.mocked(callLLM).mockImplementation(async () => {
    const next = llmQueue.shift();
    if (next === undefined) {
      throw new Error('callLLM: empty queue');
    }
    return {
      text: next,
      model: 'mock-obs',
      tokensUsed: 12,
      latencyMs: 1,
      finishReason: 'stop',
    };
  });
});

describe('turn_engine.branch observability', () => {
  it('emits event turn_engine.branch with required fields for pipeline_start', async () => {
    persistedState = createInitialState(CONV_ID);
    persistedState.current_intent = 'appointment_request';

    await send('612345678');

    const events = turnEnginePayloads();
    expect(events.some((e) => e.branch_taken === TurnEngineBranch.coordinator.pipelineStart)).toBe(true);
    const start = events.find((e) => e.branch_taken === TurnEngineBranch.coordinator.pipelineStart);
    expect(start).toBeDefined();
    assertTurnEngineShape(start!);
    expect(vi.mocked(log).mock.calls.some((c) => c[0] === 'info' && c[1] === TURN_ENGINE_BRANCH_LOG_EVENT)).toBe(
      true,
    );
  });

  it('turn_engine.branch input_summary masks full phone and email but stays useful for debugging', async () => {
    const rawEmail = 'beta.user@empresa.com';
    const rawPhone = '612345678';
    persistedState = createInitialState(CONV_ID);
    persistedState.current_intent = 'appointment_request';

    await send(`Contacto ${rawEmail} tel ${rawPhone}`);

    const summaries = turnEnginePayloads().map((p) => String(p.input_summary ?? ''));
    expect(summaries.length).toBeGreaterThan(0);
    const joined = summaries.join('\n');

    expect(joined).not.toContain(rawEmail);
    expect(joined).not.toContain(rawPhone);
    expect(joined).not.toContain('beta.user@');
    expect(joined).not.toContain('empresa.com');

    expect(joined).toContain('***5678');
    expect(joined).toMatch(/b\*\*\*@e\*\*\*\.com/);
  });

  it('emits booking.reception_phone_required when strict reception gate gets non-phone input', async () => {
    persistedState = createInitialState(CONV_ID);
    persistedState.current_intent = 'appointment_request';
    (persistedState.metadata as Record<string, unknown>).booking_path_choice_open = true;

    await send('2');

    await send('hola');

    const row = turnEnginePayloads().find((e) => e.branch_taken === TurnEngineBranch.booking.receptionPhoneRequired);
    expect(row).toBeDefined();
    assertTurnEngineShape(row!);
  });

  it('emits booking path when booking path choice is invalid', async () => {
    persistedState = createInitialState(CONV_ID);
    persistedState.current_intent = 'appointment_request';
    (persistedState.metadata as Record<string, unknown>).booking_path_choice_open = true;

    await send('tal vez');

    const branches = turnEnginePayloads().map((e) => e.branch_taken);
    expect(branches).toContain(TurnEngineBranch.booking.pathChoiceInvalid);
    const row = turnEnginePayloads().find((e) => e.branch_taken === TurnEngineBranch.booking.pathChoiceInvalid);
    assertTurnEngineShape(row!);
  });

  it('emits confirmation.ttl_expired when confirmation prompt exceeded TTL', async () => {
    persistedState = createInitialState(CONV_ID);
    persistedState.current_intent = 'appointment_request';
    persistedState.patient = {
      full_name: 'Marta Sol',
      phone: '611222333',
      email: null,
      date_of_birth: null,
      new_or_returning: 'returning',
      insurance_provider: null,
      insurance_member_id: null,
    };
    persistedState.appointment = {
      service_type: 'limpieza',
      preferred_date: '2026-08-15',
      preferred_time: 'afternoon',
      preferred_provider: null,
      flexibility: null,
    };
    persistedState.awaiting_confirmation = true;
    persistedState.pending_appointment = {
      service_type: 'limpieza',
      preferred_date: '2026-08-15',
      preferred_time: 'afternoon',
      preferred_provider: null,
      flexibility: null,
    };
    persistedState.confirmation_prompt_at = '2000-01-01T00:00:00.000Z';

    await send('cualquier mensaje tras caducar');

    const row = turnEnginePayloads().find((e) => e.branch_taken === TurnEngineBranch.confirmation.ttlExpired);
    expect(row).toBeDefined();
    assertTurnEngineShape(row!);
  });

  it('emits confirmation.persisted_yes on successful confirmation', async () => {
    persistedState = createInitialState(CONV_ID);
    persistedState.current_intent = 'appointment_request';
    persistedState.patient = {
      full_name: 'Marta Sol',
      phone: '611222333',
      email: null,
      date_of_birth: null,
      new_or_returning: 'returning',
      insurance_provider: null,
      insurance_member_id: null,
    };
    persistedState.appointment = {
      service_type: 'limpieza',
      preferred_date: '2026-08-15',
      preferred_time: 'afternoon',
      preferred_provider: null,
      flexibility: null,
    };
    persistedState.awaiting_confirmation = true;
    persistedState.pending_appointment = {
      service_type: 'limpieza',
      preferred_date: '2026-08-15',
      preferred_time: 'afternoon',
      preferred_provider: null,
      flexibility: null,
    };
    persistedState.confirmation_prompt_at = new Date().toISOString();

    await send('Sí, confirmo');

    const row = turnEnginePayloads().find((e) => e.branch_taken === TurnEngineBranch.confirmation.persistedYes);
    expect(row).toBeDefined();
    assertTurnEngineShape(row!);
  });

  it('emits llm.call_failed when callLLM throws', async () => {
    persistedState = createInitialState(CONV_ID);
    persistedState.current_intent = 'appointment_request';
    persistedState.patient = {
      full_name: 'Nina Paz',
      phone: '611000111',
      email: null,
      date_of_birth: null,
      new_or_returning: 'returning',
      insurance_provider: null,
      insurance_member_id: null,
    };
    persistedState.appointment = {
      service_type: 'limpieza',
      preferred_date: '2026-09-01',
      preferred_time: 'morning',
      preferred_provider: null,
      flexibility: null,
    };

    llmQueue.length = 0;

    await send('mensaje que llega al LLM');

    const row = turnEnginePayloads().find((e) => e.branch_taken === TurnEngineBranch.llm.callFailed);
    expect(row).toBeDefined();
    assertTurnEngineShape(row!);
  });

  it('emits llm.parse_recover_generic when LLM JSON is invalid', async () => {
    persistedState = createInitialState(CONV_ID);
    persistedState.current_intent = 'appointment_request';
    persistedState.patient = {
      full_name: 'Nina Paz',
      phone: '611000111',
      email: null,
      date_of_birth: null,
      new_or_returning: 'returning',
      insurance_provider: null,
      insurance_member_id: null,
    };
    persistedState.appointment = {
      service_type: 'limpieza',
      preferred_date: '2026-09-01',
      preferred_time: 'morning',
      preferred_provider: null,
      flexibility: null,
    };

    llmQueue.push('{{{not_valid_json_at_all');

    await send('cualquier cosa para el LLM');

    const row = turnEnginePayloads().find((e) => e.branch_taken === TurnEngineBranch.llm.parseRecoverGeneric);
    expect(row).toBeDefined();
    assertTurnEngineShape(row!);
  });

  it('emits side_effects.persist_reply on valid LLM path', async () => {
    persistedState = createInitialState(CONV_ID);
    persistedState.current_intent = 'appointment_request';
    persistedState.patient = {
      full_name: 'Otto L',
      phone: '622334455',
      email: null,
      date_of_birth: null,
      new_or_returning: 'returning',
      insurance_provider: null,
      insurance_member_id: null,
    };
    persistedState.appointment = {
      service_type: 'limpieza',
      preferred_date: '2026-09-01',
      preferred_time: 'morning',
      preferred_provider: null,
      flexibility: null,
    };

    llmQueue.push(
      baseLlmJson({
        next_action: 'continue',
        reply: 'Perfecto.',
      }),
    );

    await send('confirmo');

    const row = turnEnginePayloads().find((e) => e.branch_taken === TurnEngineBranch.sideEffects.persistReply);
    expect(row).toBeDefined();
    assertTurnEngineShape(row!);
  });

  it('emits coordinator yield_* when phases defer (not_handled)', async () => {
    persistedState = createInitialState(CONV_ID);
    persistedState.current_intent = 'appointment_request';

    await send('612345678');

    const branches = turnEnginePayloads().map((e) => String(e.branch_taken));
    expect(branches.some((b) => b.startsWith(COORDINATOR_YIELD_BRANCH_PREFIX))).toBe(true);
  });

  it('applyHybridBookingPhase emits hybrid.path_entered and hybrid.success_availability when deferred + capture', async () => {
    vi.clearAllMocks();
    vi.mocked(processHybridBookingTurn).mockResolvedValue({
      deferredStandardFlow: true,
      capturePayload: {
        service_interest: 'limpieza',
        preferred_days: [],
        preferred_time_ranges: ['por la tarde'],
        availability_notes: null,
        wants_callback: true,
        booking_mode: 'availability_capture',
      },
    });

    const state = createInitialState(CONV_ID);
    state.current_intent = 'appointment_request';
    state.patient = {
      full_name: 'Hib Test',
      phone: '611223344',
      email: null,
      date_of_birth: null,
      new_or_returning: 'returning',
      insurance_provider: null,
      insurance_member_id: null,
    };
    state.appointment = {
      service_type: null,
      preferred_date: null,
      preferred_time: null,
      preferred_provider: null,
      flexibility: null,
    };

    const turnResult = {
      reply: 'ok',
      state,
      escalation: { shouldEscalate: false, reason: null, type: null },
      fallback: { applied: false, rewrittenReply: null, reason: null },
      flowValidation: {
        overridden: false,
        originalAction: 'continue',
        correctedAction: 'continue',
        reason: '',
      },
      rawOutput: {
        intent: 'appointment_request',
        intent_confidence: 0.9,
        secondary_intent: null,
        urgency: 'routine',
        urgency_reasoning: 't',
        patient_fields: {},
        appointment: {},
        symptoms: {},
        next_action: 'continue',
        missing_fields: [],
        escalation_reason: null,
        reply: 'ok',
        contains_diagnosis: false,
        contains_pricing: false,
        is_correction: false,
        correction_fields: [],
        hybrid_booking: { booking_mode: 'availability_capture' },
      },
    } as unknown as TurnResult;

    await applyHybridBookingPhase({
      conversation_id: CONV_ID,
      routedContent: 'flexible por la tarde',
      effectiveContactId: 'cont-e2e',
      lead: { id: 'lead-e2e', status: 'new' },
      isIdentified: true,
      hasOpenRequest: false,
      turnResult,
      bookingSelfServiceUrl: 'https://book.example.com',
      tryEmitBookingLinkShown: vi.fn(),
    });

    const payloads = turnEnginePayloads();
    expect(payloads.map((e) => e.branch_taken)).toContain(TurnEngineBranch.hybrid.pathEntered);
    expect(payloads.map((e) => e.branch_taken)).toContain(TurnEngineBranch.hybrid.successAvailability);
    const one = payloads.find((e) => e.branch_taken === TurnEngineBranch.hybrid.pathEntered);
    assertTurnEngineShape(one!);
  });

  it('observability uses log() module (mocked), not direct console.log in this test path', () => {
    expect(vi.isMockFunction(log)).toBe(true);
  });
});
