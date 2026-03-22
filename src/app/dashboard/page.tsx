import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { ConversationsList } from './conversations-list';

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const params = await searchParams;
  const statusFilter = params.status;

  const supabase = createSupabaseAdminClient();

  let query = supabase
    .from('conversations')
    .select('*, contact:contacts(*)', { count: 'exact' })
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(50);

  if (statusFilter) {
    query = query.eq('status', statusFilter);
  }

  const { data, count } = await query;

  // Fetch last visible message (patient/ai/human) per conversation for the preview
  const conversationIds = (data ?? []).map((c) => (c as { id: string }).id);
  const lastMessageMap: Record<string, { content: string; role: string }> = {};

  if (conversationIds.length > 0) {
    const { data: msgRows } = await supabase
      .from('messages')
      .select('conversation_id, content, role, created_at')
      .in('conversation_id', conversationIds)
      .in('role', ['patient', 'ai', 'human'])
      .order('created_at', { ascending: false });

    for (const row of msgRows ?? []) {
      const r = row as { conversation_id: string; content: string; role: string };
      if (!lastMessageMap[r.conversation_id]) {
        lastMessageMap[r.conversation_id] = { content: r.content, role: r.role };
      }
    }
  }

  // Merge last message preview into conversation rows
  const conversationsWithPreview = (data ?? []).map((conv) => {
    const c = conv as { id: string; metadata?: Record<string, unknown> };
    const preview = lastMessageMap[c.id] ?? null;
    return {
      ...conv,
      last_message_preview: preview?.content ?? null,
      last_message_role: preview?.role ?? null,
      awaiting_confirmation: (c.metadata as any)?.conversation_state?.awaiting_confirmation ?? false,
    };
  });

  // Get counts by status for the filter tabs
  const { data: statusCounts } = await supabase
    .from('conversations')
    .select('status')
    .then(({ data: rows }) => {
      const counts: Record<string, number> = {};
      for (const row of rows ?? []) {
        const s = (row as { status: string }).status;
        counts[s] = (counts[s] ?? 0) + 1;
      }
      return { data: counts };
    });

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">Conversaciones</h1>
        <p className="text-sm text-muted-foreground">
          Supervisa y gestiona las conversaciones con pacientes.
        </p>
      </div>

      <ConversationsList
        conversations={conversationsWithPreview}
        total={count ?? 0}
        currentStatus={statusFilter}
        statusCounts={statusCounts ?? {}}
      />
    </div>
  );
}
