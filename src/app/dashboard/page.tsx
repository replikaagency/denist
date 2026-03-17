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

  // Get counts by status for the filter tabs
  const { data: statusCounts } = await supabase
    .from('conversations')
    .select('status')
    .then(({ data }) => {
      const counts: Record<string, number> = {};
      for (const row of data ?? []) {
        const s = (row as { status: string }).status;
        counts[s] = (counts[s] ?? 0) + 1;
      }
      return { data: counts };
    });

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">Conversations</h1>
        <p className="text-sm text-muted-foreground">
          Monitor and manage patient conversations.
        </p>
      </div>

      <ConversationsList
        conversations={data ?? []}
        total={count ?? 0}
        currentStatus={statusFilter}
        statusCounts={statusCounts ?? {}}
      />
    </div>
  );
}
