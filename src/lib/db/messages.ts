import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { AppError } from '@/lib/errors';
import type { Message, MessageRole } from '@/types/database';

const db = () => createSupabaseAdminClient();

/** Maximum messages fetched as context window for the AI. */
const CONTEXT_WINDOW = 20;

export interface MessageInsertInput {
  conversation_id: string;
  role: MessageRole;
  content: string;
  model?: string | null;
  tokens_used?: number | null;
  finish_reason?: string | null;
  latency_ms?: number | null;
  metadata?: Record<string, unknown>;
}

export async function insertMessage(insert: MessageInsertInput): Promise<Message> {
  const { data, error } = await db()
    .from('messages')
    .insert({
      ...insert,
      metadata: insert.metadata ?? {},
    })
    .select('*')
    .single();

  if (error) throw AppError.database('Failed to persist message', error);
  return data as Message;
}

/**
 * Fetch the most recent N messages for a conversation, oldest-first.
 * Used to build the AI context window.
 */
export async function getRecentMessages(
  conversationId: string,
  limit = CONTEXT_WINDOW,
): Promise<Message[]> {
  const { data, error } = await db()
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw AppError.database('Failed to fetch messages', error);

  // Reverse so oldest is first (chronological order for AI context)
  return ((data ?? []) as Message[]).reverse();
}

/**
 * Fetch all messages for a conversation (for the admin dashboard).
 */
export async function getAllMessages(conversationId: string): Promise<Message[]> {
  const { data, error } = await db()
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });

  if (error) throw AppError.database('Failed to fetch messages', error);
  return (data ?? []) as Message[];
}

/**
 * Insert a patient message and an AI message in a single round-trip.
 */
export async function insertMessagePair(
  patientMsg: Omit<MessageInsertInput, 'role'>,
  aiMsg: Omit<MessageInsertInput, 'role'>,
): Promise<[Message, Message]> {
  const toInsert = [
    { ...patientMsg, role: 'patient' as MessageRole, metadata: patientMsg.metadata ?? {} },
    { ...aiMsg, role: 'ai' as MessageRole, metadata: aiMsg.metadata ?? {} },
  ];

  const { data, error } = await db()
    .from('messages')
    .insert(toInsert)
    .select('*');

  if (error) throw AppError.database('Failed to persist message pair', error);
  const rows = data as Message[];
  return [rows[0], rows[1]];
}
