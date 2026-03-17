'use client';

import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800',
  confirmed: 'bg-emerald-100 text-emerald-800',
  cancelled: 'bg-red-100 text-red-700',
  no_show: 'bg-gray-100 text-gray-600',
  completed: 'bg-blue-100 text-blue-800',
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
  no_show: 'No Show',
  completed: 'Completed',
};

const APPOINTMENT_TYPE_LABELS: Record<string, string> = {
  new_patient: 'New Patient',
  checkup: 'Check-up',
  emergency: 'Emergency',
  whitening: 'Whitening',
  implant_consult: 'Implant Consult',
  orthodontic_consult: 'Orthodontic Consult',
  other: 'Other',
};

function toTitleCase(str: string) {
  return str.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function AppointmentsList({
  requests,
  total,
}: {
  requests: Record<string, unknown>[];
  total: number;
}) {
  const router = useRouter();

  async function updateStatus(id: string, status: string) {
    await fetch(`/api/appointment-requests/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    router.refresh();
  }

  return (
    <Card>
      <CardHeader className="py-3 px-5">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {total} request{total !== 1 ? 's' : ''}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {requests.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-muted-foreground">
            No appointment requests yet.
          </div>
        ) : (
          <div className="divide-y">
            {requests.map((req) => {
              const contact = req.contact as Record<string, unknown> | null;
              const name = contact
                ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'Anonymous'
                : 'Unknown';
              const status = req.status as string;
              const isPending = status === 'pending';

              return (
                <div key={req.id as string} className="flex items-center gap-4 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{name}</span>
                      <Badge variant="outline" className={`text-[10px] ${STATUS_COLORS[status] ?? ''}`}>
                        {STATUS_LABELS[status] ?? toTitleCase(status)}
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        {APPOINTMENT_TYPE_LABELS[req.appointment_type as string] ?? toTitleCase(req.appointment_type as string)}
                      </Badge>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {req.preferred_date ? (
                        <span>Preferred: {formatDate(String(req.preferred_date))}</span>
                      ) : null}
                      {req.preferred_time_of_day ? (
                        <span> · {String(req.preferred_time_of_day)}</span>
                      ) : null}
                      {req.notes ? <span> · {String(req.notes)}</span> : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {formatDate(req.created_at as string)}
                    </span>
                    {isPending && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-xs"
                          onClick={() => updateStatus(req.id as string, 'confirmed')}
                        >
                          Confirm
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-xs text-destructive"
                          onClick={() => updateStatus(req.id as string, 'cancelled')}
                        >
                          Cancel
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
