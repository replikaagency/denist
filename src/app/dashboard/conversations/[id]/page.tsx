import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { notFound } from 'next/navigation';
import { ConversationDetail } from './conversation-detail';

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = createSupabaseAdminClient();

  const { data: conversation } = await supabase
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('id', id)
    .maybeSingle();

  if (!conversation) notFound();

  const { data: messages } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true });

  const { data: handoffs } = await supabase
    .from('handoff_events')
    .select('*')
    .eq('conversation_id', id)
    .order('created_at', { ascending: false })
    .limit(1);

  return (
    <div className="mx-auto max-w-4xl">
      <ConversationDetail
        conversation={conversation as Record<string, unknown>}
        messages={(messages ?? []) as Record<string, unknown>[]}
        handoff={(handoffs?.[0] ?? null) as Record<string, unknown> | null}
      />
    </div>
  );
}
