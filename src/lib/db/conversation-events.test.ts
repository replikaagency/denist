import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { appendConversationEvent } from './conversation-events';

const insertMock = vi.fn();

vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => ({
    from: () => ({
      insert: (...args: unknown[]) => insertMock(...args),
    }),
  }),
}));

vi.mock('@/lib/logger', () => ({
  log: vi.fn(),
}));

describe('appendConversationEvent', () => {
  beforeEach(() => {
    insertMock.mockReturnValue(Promise.resolve({ error: null }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('inserts without throwing when Supabase succeeds', async () => {
    appendConversationEvent({
      conversationId: 'c1',
      contactId: 'u1',
      leadId: 'l1',
      eventType: 'booking_link_shown',
      source: 'chat',
      metadata: { x: 1 },
    });
    await vi.waitFor(() => expect(insertMock).toHaveBeenCalled());
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation_id: 'c1',
        contact_id: 'u1',
        lead_id: 'l1',
        event_type: 'booking_link_shown',
        source: 'chat',
        metadata: {
          x: 1,
          conversation_id: 'c1',
          contact_id: 'u1',
          lead_id: 'l1',
        },
      }),
    );
  });

  it('does not throw when insert returns error', async () => {
    insertMock.mockReturnValue(Promise.resolve({ error: { message: 'fail' } }));
    expect(() =>
      appendConversationEvent({
        conversationId: 'c1',
        contactId: 'u1',
        eventType: 'handoff_created',
      }),
    ).not.toThrow();
    await vi.waitFor(() => expect(insertMock).toHaveBeenCalled());
  });
});
