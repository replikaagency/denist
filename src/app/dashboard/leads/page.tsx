import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const STATUS_COLORS: Record<string, string> = {
  new: 'bg-blue-100 text-blue-800',
  contacted: 'bg-indigo-100 text-indigo-800',
  qualified: 'bg-purple-100 text-purple-800',
  appointment_requested: 'bg-amber-100 text-amber-800',
  booked: 'bg-emerald-100 text-emerald-800',
  lost: 'bg-red-100 text-red-700',
  disqualified: 'bg-gray-100 text-gray-600',
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default async function LeadsPage() {
  const supabase = createSupabaseAdminClient();
  const { data: leads, count } = await supabase
    .from('leads')
    .select('*, contact:contacts(*)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .limit(100);

  const rows = (leads ?? []) as Array<{
    id: string;
    status: string;
    source: string | null;
    treatment_interest: string[];
    notes: string | null;
    created_at: string;
    contact: {
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      phone: string | null;
    } | null;
  }>;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">Leads</h1>
        <p className="text-sm text-muted-foreground">
          Track patient leads through the sales funnel.
        </p>
      </div>

      <Card>
        <CardHeader className="py-3 px-5">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {count ?? 0} lead{count !== 1 ? 's' : ''}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-muted-foreground">
              No leads yet. Leads are created when patients share their contact info.
            </div>
          ) : (
            <div className="divide-y">
              {rows.map((lead) => {
                const name = lead.contact
                  ? [lead.contact.first_name, lead.contact.last_name].filter(Boolean).join(' ') || 'Anonymous'
                  : 'Unknown';

                return (
                  <div key={lead.id} className="flex items-center gap-4 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{name}</span>
                        <Badge variant="outline" className={`text-[10px] ${STATUS_COLORS[lead.status] ?? ''}`}>
                          {lead.status.replace('_', ' ')}
                        </Badge>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                        {lead.contact?.email && <span>{lead.contact.email}</span>}
                        {lead.contact?.phone && <span>{lead.contact.phone}</span>}
                        {lead.treatment_interest?.length > 0 && (
                          <span>· {lead.treatment_interest.join(', ')}</span>
                        )}
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {lead.source && <span className="mr-3">{lead.source}</span>}
                      {formatDate(lead.created_at)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
