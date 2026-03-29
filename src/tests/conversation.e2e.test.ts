/**
 * End-to-end style tests over processChatMessage: real conversation engine + fields,
 * mocked IO (DB, LLM). Detects repreguntas, broken branches, and bad transitions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Conversation } from '@/types/database';
import type { ConversationState } from '@/lib/conversation/schema';
import { createInitialState } from '@/lib/conversation/schema';
import { processChatMessage } from '@/services/chat.service';
import * as conversationService from '@/services/conversation.service';
import * as appointmentService from '@/services/appointment.service';
import { callLLM } from '@/lib/ai/completion';
import { FRUSTRATION_ESCALATION_REPLY_ES } from '@/lib/conversation/confirmation';
import { RECEPTION_PHONE_GATE_INVALID_REPLY } from '@/lib/conversation/response-builder';
import { getContactById } from '@/lib/db/contacts';
import { insertMessage, getRecentMessages } from '@/lib/db/messages';
import { createHandoff } from '@/services/handoff.service';

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
  processHybridBookingTurn: () => Promise.resolve({ deferredStandardFlow: false }),
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

const CONV_ID = 'conv-e2e';
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

function normReply(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function aiContentsFromTranscript(): string[] {
  return transcript.filter((m) => m.role === 'ai').map((m) => m.content);
}

/** Fails if two consecutive AI messages are identical (classic repregunta bug). */
function assertNoConsecutiveDuplicateAi(): void {
  const ai = aiContentsFromTranscript().map(normReply);
  for (let i = 1; i < ai.length; i++) {
    expect(ai[i]).not.toBe(ai[i - 1]);
  }
}

/** Keeps assistant copy bounded (single bubble, clinic tone — no essays). */
function assertShortClinicLike(reply: string, maxLen = 1200): void {
  expect(reply.length).toBeLessThanOrEqual(maxLen);
}

function baseLlmJson(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    intent: 'appointment_request',
    intent_confidence: 0.95,
    secondary_intent: null,
    urgency: 'routine',
    urgency_reasoning: 'e2e',
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

  vi.mocked(insertMessage).mockImplementation(async (input: { role: string; content: string }) => {
    const id = `m${transcript.length}`;
    transcript.push({ id, role: input.role, content: input.content });
    return { id, content: input.content } as never;
  });
  vi.mocked(getRecentMessages).mockImplementation(async () => transcript as never);

  vi.mocked(conversationService.verifyOwnership).mockResolvedValue(mockConversation);
  vi.mocked(conversationService.touch).mockResolvedValue(undefined);
  vi.mocked(conversationService.getConversationById).mockResolvedValue(mockConversation);
  vi.mocked(conversationService.loadState).mockImplementation(async () =>
    structuredClone(persistedState),
  );
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
      throw new Error('callLLM: empty queue (add a response for this turn)');
    }
    return {
      text: next,
      model: 'mock-e2e',
      tokensUsed: 12,
      latencyMs: 1,
      finishReason: 'stop',
    };
  });
});

describe('conversation e2e', () => {
  it('TEST 1: user gives phone before name is asked — captures phone, next asks name, no phone repregunta', async () => {
    persistedState = createInitialState(CONV_ID);
    persistedState.current_intent = 'appointment_request';

    await send('612345678');

    expect(persistedState.patient.phone).toBeTruthy();
    expect(persistedState.patient.full_name).toBeNull();

    const asksPhonePrompt = aiContentsFromTranscript().some((c) =>
      /¿A qué número te podemos llamar/i.test(c),
    );
    const asksName = aiContentsFromTranscript().some((c) => /nombre/i.test(c));
    expect(asksPhonePrompt).toBe(false);
    expect(asksName).toBe(true);

    assertNoConsecutiveDuplicateAi();
  });

  it('TEST 2: user says "quiero lo antes posible" — ASAP slot branch, 1/2/3 choice', async () => {
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
      preferred_date: null,
      preferred_time: null,
      preferred_provider: null,
      flexibility: null,
    };

    await send('quiero lo antes posible');

    expect((persistedState.metadata as Record<string, unknown>).asap_slot_choice_open).toBe(true);
    const lastAi = aiContentsFromTranscript().at(-1) ?? '';
    expect(lastAi).toMatch(/1|2|3/);
    assertNoConsecutiveDuplicateAi();
  });

  it('TEST 3: invalid booking path option then correction — strict retry then valid 1', async () => {
    const prevUrl = process.env.BOOKING_SELF_SERVICE_URL;
    process.env.BOOKING_SELF_SERVICE_URL = 'https://book.example.com/cita';

    persistedState = createInitialState(CONV_ID);
    persistedState.current_intent = 'appointment_request';
    (persistedState.metadata as Record<string, unknown>).booking_path_choice_open = true;

    await send('tal vez');
    expect(aiContentsFromTranscript().at(-1)).toMatch(/Para avanzar|1|2/u);

    llmQueue.push(
      baseLlmJson({
        next_action: 'continue',
        reply: 'Perfecto.',
      }),
    );
    await send('1');

    expect((persistedState.metadata as Record<string, unknown>).booking_path_choice_open).toBe(false);
    const joined = aiContentsFromTranscript().join('\n');
    expect(joined).toMatch(/book\.example\.com/);
    assertNoConsecutiveDuplicateAi();

    process.env.BOOKING_SELF_SERVICE_URL = prevUrl;
  });

  it('TEST 4: user gives name + phone together — both captured, single coherent transition', async () => {
    persistedState = createInitialState(CONV_ID);
    persistedState.current_intent = 'appointment_request';

    llmQueue.push(
      baseLlmJson({
        next_action: 'ask_field',
        reply: '¿Es tu primera vez en la clínica?',
      }),
    );

    await send('Soy Carlos Ruiz, mi móvil es 642220099');

    expect(persistedState.patient.full_name).toMatch(/Carlos/i);
    expect(persistedState.patient.phone).toBeTruthy();
    assertNoConsecutiveDuplicateAi();
    const namePromptCount = aiContentsFromTranscript().filter((c) =>
      /nombre completo/i.test(c),
    ).length;
    expect(namePromptCount).toBeLessThanOrEqual(1);
  });

  it('TEST 5: full booking until confirmation prompt — intake + LLM offer_appointment (same turn as date)', async () => {
    persistedState = createInitialState(CONV_ID);
    persistedState.current_intent = 'appointment_request';

    await send('Soy Elena Ramos 655443322 es mi primera vez limpieza');

    expect(persistedState.patient.full_name).toBeTruthy();
    expect(persistedState.patient.phone).toBeTruthy();
    expect(persistedState.patient.new_or_returning).toBe('new');
    expect(persistedState.appointment.service_type).toBeTruthy();
    expect(persistedState.appointment.preferred_date).toBeNull();
    expect(persistedState.appointment.preferred_time).toBeNull();

    // Must be offer_appointment (not ask_field) once data is complete — otherwise the engine
    // sets completed=true and the next turn is terminal, blocking the confirmation step.
    llmQueue.push(
      baseLlmJson({
        appointment: { preferred_date: '2026-08-15', preferred_time: 'afternoon' },
        next_action: 'offer_appointment',
        missing_fields: [],
        reply:
          'Resumo: cita solicitada. ¿Confirmas que registramos la solicitud tal como la tienes?',
      }),
    );
    // Bare ISO avoids intake booking_shortcut (which would skip the LLM and leave date null).
    await send('2026-08-15');

    expect(persistedState.appointment.preferred_date).toBe('2026-08-15');
    expect(persistedState.appointment.preferred_time).toBe('afternoon');

    expect(persistedState.awaiting_confirmation).toBe(true);
    expect(persistedState.pending_appointment).not.toBeNull();
    const meta = aiContentsFromTranscript().some(
      (c) => /confirm|resumo|resumen|registr/i.test(c),
    );
    expect(meta).toBe(true);
    assertNoConsecutiveDuplicateAi();
  });

  it('TEST 6: reception path (2) — phone strict gate before anything else; invalid text gets guided retry', async () => {
    const prevUrl = process.env.BOOKING_SELF_SERVICE_URL;
    process.env.BOOKING_SELF_SERVICE_URL = 'https://book.example.com/cita';

    persistedState = createInitialState(CONV_ID);
    persistedState.current_intent = 'appointment_request';
    (persistedState.metadata as Record<string, unknown>).booking_path_choice_open = true;

    await send('2');

    expect((persistedState.metadata as Record<string, unknown>).reception_phone_strict_gate).toBe(true);
    expect(persistedState.patient.phone).toBeFalsy();
    const afterChoice = aiContentsFromTranscript().at(-1) ?? '';
    assertShortClinicLike(afterChoice);
    expect(afterChoice.toLowerCase()).toMatch(/tel[eé]fono|n[uú]mero|llamar/i);

    await send('hola');

    expect(aiContentsFromTranscript().at(-1)).toBe(RECEPTION_PHONE_GATE_INVALID_REPLY);
    assertShortClinicLike(RECEPTION_PHONE_GATE_INVALID_REPLY, 500);

    llmQueue.push(
      baseLlmJson({
        next_action: 'ask_field',
        reply: 'Gracias. ¿Es tu primera vez en la clínica?',
      }),
    );
    await send('612998877');

    expect(persistedState.patient.phone).toBeTruthy();
    expect((persistedState.metadata as Record<string, unknown>).reception_phone_strict_gate).toBeFalsy();
    const phonePrompts = aiContentsFromTranscript().filter((c) =>
      /tel[eé]fono.*9\s*d[ií]gitos|9\s*d[ií]gitos.*tel[eé]fono/i.test(c),
    );
    expect(phonePrompts.length).toBeLessThanOrEqual(2);
    assertNoConsecutiveDuplicateAi();

    process.env.BOOKING_SELF_SERVICE_URL = prevUrl;
  });

  it('TEST 7: booking "lo antes posible" (bare phrase) — ASAP 1/2/3, no duplicate slot prompts', async () => {
    persistedState = createInitialState(CONV_ID);
    persistedState.current_intent = 'appointment_request';
    persistedState.patient = {
      full_name: 'Laura Pérez',
      phone: '611000111',
      email: null,
      date_of_birth: null,
      new_or_returning: 'returning',
      insurance_provider: null,
      insurance_member_id: null,
    };
    persistedState.appointment = {
      service_type: 'limpieza',
      preferred_date: null,
      preferred_time: null,
      preferred_provider: null,
      flexibility: null,
    };

    await send('lo antes posible');

    expect((persistedState.metadata as Record<string, unknown>).asap_slot_choice_open).toBe(true);
    const lastAi = aiContentsFromTranscript().at(-1) ?? '';
    expect(lastAi).toMatch(/1|2|3/);
    assertShortClinicLike(lastAi);
    assertNoConsecutiveDuplicateAi();
  });

  it('TEST 8: name then phone on separate turns — both stored, no re-ask for name after phone', async () => {
    persistedState = createInitialState(CONV_ID);
    persistedState.current_intent = 'appointment_request';

    llmQueue.push(
      baseLlmJson({
        next_action: 'ask_field',
        reply: '¿Qué tratamiento o motivo de consulta?',
      }),
    );

    await send('Me llamo Pedro Gómez');

    expect(persistedState.patient.full_name).toMatch(/Pedro/i);
    expect(persistedState.patient.phone).toBeFalsy();

    llmQueue.push(
      baseLlmJson({
        next_action: 'continue',
        reply: 'Anotado.',
      }),
    );
    await send('644556677');

    expect(persistedState.patient.phone).toBeTruthy();
    expect(persistedState.patient.full_name).toMatch(/Pedro/i);
    const nameAsks = aiContentsFromTranscript().filter((c) =>
      /c[oó]mo te llamas|nombre completo|tu nombre/i.test(c),
    );
    expect(nameAsks.length).toBeLessThanOrEqual(1);
    assertNoConsecutiveDuplicateAi();
  });

  it('TEST 9: confirmation "sí" — request persisted, leaves awaiting_confirmation, optional email gate', async () => {
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

    expect(vi.mocked(appointmentService.createRequest)).toHaveBeenCalled();
    expect(persistedState.awaiting_confirmation).toBe(false);
    expect(persistedState.pending_appointment).toBeNull();
    expect(persistedState.completed).toBe(true);
    expect((persistedState.metadata as Record<string, unknown>).optional_email_choice_open).toBe(true);
    const lastAi = aiContentsFromTranscript().at(-1) ?? '';
    expect(lastAi).toMatch(/Solicitud registrada|correo/i);
    assertShortClinicLike(lastAi);
    assertNoConsecutiveDuplicateAi();
  });

  it('TEST 10: frustrated user — deterministic handoff, canonical short reply', async () => {
    persistedState = createInitialState(CONV_ID);
    persistedState.current_intent = 'appointment_request';
    persistedState.patient = {
      full_name: 'Ana Ruiz',
      phone: '600111222',
      email: null,
      date_of_birth: null,
      new_or_returning: 'returning',
      insurance_provider: null,
      insurance_member_id: null,
    };

    await send('no me entiendes');

    expect(vi.mocked(createHandoff)).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: CONV_ID,
        escalation: expect.objectContaining({ shouldEscalate: true, type: 'human' }),
      }),
    );
    expect(persistedState.escalated).toBe(true);
    expect(aiContentsFromTranscript().at(-1)).toBe(FRUSTRATION_ESCALATION_REPLY_ES);
    assertShortClinicLike(FRUSTRATION_ESCALATION_REPLY_ES);
    assertNoConsecutiveDuplicateAi();
  });

  it('TEST 11: LLM human handoff intent — createHandoff via side-effects', async () => {
    persistedState = createInitialState(CONV_ID);
    persistedState.current_intent = 'appointment_request';
    persistedState.patient = {
      full_name: 'Luis Mena',
      phone: '622334455',
      email: null,
      date_of_birth: null,
      new_or_returning: 'returning',
      insurance_provider: null,
      insurance_member_id: null,
    };
    persistedState.appointment = {
      service_type: 'limpieza',
      preferred_date: null,
      preferred_time: null,
      preferred_provider: null,
      flexibility: null,
    };

    llmQueue.push(
      baseLlmJson({
        intent: 'human_handoff_request',
        next_action: 'escalate_human',
        escalation_reason: 'Patient asked for staff.',
        reply: 'Te paso con recepción en un momento.',
      }),
    );

    await send('Necesito hablar con una persona de la clínica');

    expect(vi.mocked(createHandoff)).toHaveBeenCalled();
    expect(persistedState.escalated).toBe(true);
    const lastAi = aiContentsFromTranscript().at(-1) ?? '';
    expect(lastAi.length).toBeLessThan(500);
    assertNoConsecutiveDuplicateAi();
  });
});
