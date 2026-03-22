import {
  createConversation,
  getConversationById,
  getConversationForContact,
  updateConversation,
  touchConversation,
} from '@/lib/db/conversations';
import { getContactById } from '@/lib/db/contacts';
import { getRecentMessages } from '@/lib/db/messages';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import {
  ConversationStateSchema,
  createInitialState,
  type ConversationState,
} from '@/lib/conversation/schema';
import { AppError } from '@/lib/errors';
import type { Conversation, ConversationStatus } from '@/types/database';

/**
 * Load conversation state from `conversations.metadata.conversation_state`.
 * Creates a blank initial state if this is the first turn.
 */
export async function loadState(conversationId: string): Promise<ConversationState> {
  const conversation = await getConversationById(conversationId);
  const raw = (conversation.metadata as Record<string, unknown>)?.conversation_state;

  if (!raw) return createInitialState(conversationId);

  const parsed = ConversationStateSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn('[ConversationService] Corrupted state, resetting:', parsed.error.message);
    return createInitialState(conversationId);
  }

  return parsed.data;
}

/**
 * Persist the updated conversation state back to the metadata column.
 * Returns the updated Conversation so callers can avoid a redundant read.
 */
export async function saveState(
  conversationId: string,
  state: ConversationState,
): Promise<Conversation> {
  const conversation = await getConversationById(conversationId);
  const existingMetadata = (conversation.metadata ?? {}) as Record<string, unknown>;

  return updateConversation(conversationId, {
    metadata: { ...existingMetadata, conversation_state: state },
  });
}

/**
 * Keeps the appointment_request_open flag in conversation state in sync with
 * DB reality after an appointment_requests status change (e.g. staff PATCH).
 *
 * Performs exactly one read + one conditional write. Does NOT use
 * loadState/saveState to avoid a double getConversationById call.
 * Merges safely: all existing metadata keys and all other conversation_state
 * fields are preserved — only appointment_request_open is touched.
 *
 * No-ops silently when conversationId is null (appointments with no linked
 * conversation) or when the flag is already correct.
 */
export async function syncAppointmentRequestFlag(
  conversationId: string | null | undefined,
  isOpen: boolean,
): Promise<void> {
  if (!conversationId) return;

  const conversation = await getConversationById(conversationId);
  const existingMetadata = (conversation.metadata ?? {}) as Record<string, unknown>;
  const rawState = (existingMetadata.conversation_state ?? {}) as Record<string, unknown>;

  // Already in sync — skip the write.
  if (!!rawState.appointment_request_open === isOpen) return;

  await updateConversation(conversationId, {
    metadata: {
      ...existingMetadata,
      conversation_state: { ...rawState, appointment_request_open: isOpen },
    },
  });
}

/**
 * Transition conversation status with invariant enforcement.
 * When leaving `active`, automatically disables AI.
 */
export async function transitionStatus(
  conversationId: string,
  newStatus: ConversationStatus,
): Promise<Conversation> {
  const patch: Partial<Pick<Conversation, 'status' | 'ai_enabled'>> = { status: newStatus };

  if (newStatus !== 'active') {
    patch.ai_enabled = false;
  }

  return updateConversation(conversationId, patch);
}

/**
 * Start a new conversation for a contact, or resume the most recent active one.
 */
export async function startOrResumeConversation(contactId: string): Promise<{
  conversation: Conversation;
  isNew: boolean;
}> {
  const db = createSupabaseAdminClient();

  // Resume any in-progress conversation — active, waiting for staff, or staff
  // currently handling. Creating a new conversation would orphan the handoff
  // and lose continuity for the patient.
  const { data: existing, error } = await db
    .from('conversations')
    .select('*')
    .eq('contact_id', contactId)
    .in('status', ['active', 'waiting_human', 'human_active'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw AppError.database('Failed to find active conversation', error);

  if (existing) {
    return { conversation: existing as Conversation, isNew: false };
  }

  const conversation = await createConversation({ contact_id: contactId });
  return { conversation, isNew: true };
}

/**
 * Verify the requester owns this conversation: load conversation (source of truth
 * for contact_id), then require that contact's session_token matches the token
 * from the browser (survives contact merge / relink).
 */
export async function verifyOwnership(
  conversationId: string,
  sessionToken: string,
): Promise<Conversation> {
  const conversation = await getConversationById(conversationId);
  const owner = await getContactById(conversation.contact_id);
  if (owner.session_token !== sessionToken) {
    throw AppError.notFound('Conversation', conversationId);
  }
  return conversation;
}

/**
 * Update the last_message_at timestamp.
 */
export async function touch(conversationId: string): Promise<void> {
  await touchConversation(conversationId);
}

export {
  getConversationById,
  getConversationForContact,
  updateConversation,
  touchConversation,
  getRecentMessages,
};
