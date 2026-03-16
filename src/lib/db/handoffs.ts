import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { AppError } from '@/lib/errors';
import type { HandoffEvent, HandoffReason } from '@/types/database';

const db = () => createSupabaseAdminClient();

export async function createHandoffEvent(insert: {
  conversation_id: string;
  contact_id: string;
  reason: HandoffReason;
  trigger_message_id?: string;
  notes?: string;
}): Promise<HandoffEvent> {
  const { data, error } = await db()
    .from('handoff_events')
    .insert({
      conversation_id: insert.conversation_id,
      contact_id: insert.contact_id,
      reason: insert.reason,
      trigger_message_id: insert.trigger_message_id ?? null,
      notes: insert.notes ?? null,
    })
    .select('*')
    .single();

  if (error) throw AppError.database('Failed to create handoff event', error);
  return data as HandoffEvent;
}

export async function getOpenHandoffForConversation(
  conversationId: string,
): Promise<HandoffEvent | null> {
  const { data, error } = await db()
    .from('handoff_events')
    .select('*')
    .eq('conversation_id', conversationId)
    .is('resolved_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw AppError.database('Failed to fetch handoff event', error);
  return data as HandoffEvent | null;
}

export async function resolveHandoffEvent(
  id: string,
  notes?: string,
): Promise<HandoffEvent> {
  const { data, error } = await db()
    .from('handoff_events')
    .update({
      resolved_at: new Date().toISOString(),
      ...(notes ? { notes } : {}),
    })
    .eq('id', id)
    .select('*')
    .single();

  if (error) throw AppError.database('Failed to resolve handoff event', error);
  if (!data) throw AppError.notFound('HandoffEvent', id);
  return data as HandoffEvent;
}
