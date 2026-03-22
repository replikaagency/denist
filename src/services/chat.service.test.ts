import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Conversation } from '@/types/database';
import { getContactById } from '@/lib/db/contacts';
import { createInitialState } from '@/lib/conversation/schema';
import * as conversationService from './conversation.service';
import * as appointmentService from './appointment.service';
import { callLLM } from '@/lib/ai/completion';
import { processChatMessage } from './chat.service';

vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

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
    findOpenAppointmentRequest: () => Promise.resolve(null),
    findOpenRequestsForContact: () => Promise.resolve([]),
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
  getMissingFields: () => [],
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
});
