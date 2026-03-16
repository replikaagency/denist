import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { AppError } from '@/lib/errors';
import type { Conversation, ConversationChannel, ConversationStatus } from '@/types/database';

const db = () => createSupabaseAdminClient();

export async function createConversation(insert: {
  contact_id: string;
  channel?: ConversationChannel;
  metadata?: Record<string, unknown>;
}): Promise<Conversation> {
  const { data, error } = await db()
    .from('conversations')
    .insert({
      contact_id: insert.contact_id,
      channel: insert.channel ?? 'web_chat',
      status: 'active',
      ai_enabled: true,
      metadata: insert.metadata ?? {},
    })
    .select('*')
    .single();

  if (error) throw AppError.database('Failed to create conversation', error);
  return data as Conversation;
}

export async function getConversationById(id: string): Promise<Conversation> {
  const { data, error } = await db()
    .from('conversations')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw AppError.database('Failed to fetch conversation', error);
  if (!data) throw AppError.notFound('Conversation', id);
  return data as Conversation;
}

/**
 * Verify a conversation belongs to a given contact (session auth check).
 */
export async function getConversationForContact(
  conversationId: string,
  contactId: string,
): Promise<Conversation> {
  const { data, error } = await db()
    .from('conversations')
    .select('*')
    .eq('id', conversationId)
    .eq('contact_id', contactId)
    .maybeSingle();

  if (error) throw AppError.database('Failed to fetch conversation', error);
  if (!data) throw AppError.notFound('Conversation', conversationId);
  return data as Conversation;
}

export async function updateConversationStatus(
  id: string,
  status: ConversationStatus,
): Promise<Conversation> {
  const { data, error } = await db()
    .from('conversations')
    .update({ status })
    .eq('id', id)
    .select('*')
    .single();

  if (error) throw AppError.database('Failed to update conversation status', error);
  if (!data) throw AppError.notFound('Conversation', id);
  return data as Conversation;
}

export async function updateConversation(
  id: string,
  patch: Partial<Pick<Conversation, 'status' | 'ai_enabled' | 'summary' | 'lead_id' | 'last_message_at' | 'metadata'>>,
): Promise<Conversation> {
  const { data, error } = await db()
    .from('conversations')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();

  if (error) throw AppError.database('Failed to update conversation', error);
  if (!data) throw AppError.notFound('Conversation', id);
  return data as Conversation;
}

export async function touchConversation(id: string): Promise<void> {
  const { error } = await db()
    .from('conversations')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw AppError.database('Failed to update conversation timestamp', error);
}
