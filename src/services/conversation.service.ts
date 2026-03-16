import {
  createConversation,
  getConversationById,
  getConversationForContact,
  updateConversation,
  touchConversation,
} from '@/lib/db/conversations';
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
 */
export async function saveState(
  conversationId: string,
  state: ConversationState,
): Promise<void> {
  const conversation = await getConversationById(conversationId);
  const existingMetadata = (conversation.metadata ?? {}) as Record<string, unknown>;

  await updateConversation(conversationId, {
    metadata: { ...existingMetadata, conversation_state: state },
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

  const { data: existing, error } = await db
    .from('conversations')
    .select('*')
    .eq('contact_id', contactId)
    .eq('status', 'active')
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
 * Verify a conversation belongs to a given contact (session auth).
 */
export async function verifyOwnership(
  conversationId: string,
  contactId: string,
): Promise<Conversation> {
  return getConversationForContact(conversationId, contactId);
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
