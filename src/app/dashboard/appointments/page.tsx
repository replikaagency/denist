import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { AppointmentsList } from './appointments-list';

export default async function AppointmentsPage() {
  const supabase = createSupabaseAdminClient();
  const { data: requests, count } = await supabase
    .from('appointment_requests')
    .select('*, contact:contacts(*)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .limit(100);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">Appointment Requests</h1>
        <p className="text-sm text-muted-foreground">
          Review and manage patient appointment requests.
        </p>
      </div>

      <AppointmentsList
        requests={(requests ?? []) as Record<string, unknown>[]}
        total={count ?? 0}
      />
    </div>
  );
}
