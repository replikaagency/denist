'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800',
  confirmed: 'bg-emerald-100 text-emerald-800',
  cancelled: 'bg-red-100 text-red-700',
  no_show: 'bg-gray-100 text-gray-600',
  completed: 'bg-blue-100 text-blue-800',
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pendiente',
  confirmed: 'Confirmada',
  cancelled: 'Cancelada',
  no_show: 'No asistió',
  completed: 'Completada',
};

const APPOINTMENT_TYPE_LABELS: Record<string, string> = {
  new_patient: 'Paciente nuevo',
  checkup: 'Revisión',
  emergency: 'Urgencia',
  whitening: 'Blanqueamiento',
  implant_consult: 'Consulta de implantes',
  orthodontic_consult: 'Consulta de ortodoncia',
  other: 'Otro',
};

const PREFERRED_TIME_LABELS: Record<string, string> = {
  morning: 'Mañana',
  afternoon: 'Tarde',
  evening: 'Tarde',
  night: 'Noche',
  any: 'Flexible',
};

function toTitleCase(str: string) {
  return str.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-ES', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Format local date for datetime-local input (YYYY-MM-DDTHH:mm) */
function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function AppointmentsList({
  requests,
  total,
}: {
  requests: Record<string, unknown>[];
  total: number;
}) {
  const router = useRouter();
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [confirmDatetime, setConfirmDatetime] = useState('');

  function openConfirmDialog(id: string) {
    const d = new Date();
    d.setHours(9, 0, 0, 0);
    setConfirmDatetime(toDatetimeLocal(d));
    setConfirmingId(id);
  }

  async function updateStatus(id: string, status: string, confirmed_datetime?: string) {
    const body: Record<string, string> = { status };
    if (confirmed_datetime) body.confirmed_datetime = confirmed_datetime;

    const res = await fetch(`/api/appointment-requests/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err?.error?.message ?? 'No se pudo actualizar');
      return;
    }
    setConfirmingId(null);
    router.refresh();
  }

  async function submitConfirm() {
    if (!confirmingId || !confirmDatetime.trim()) return;
    const iso = new Date(confirmDatetime).toISOString();
    await updateStatus(confirmingId, 'confirmed', iso);
  }

  return (
    <>
    <Card>
      <CardHeader className="py-3 px-5">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {total} {total !== 1 ? 'solicitudes' : 'solicitud'}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {requests.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-muted-foreground">
            Aún no hay solicitudes de cita.
          </div>
        ) : (
          <div className="divide-y">
            {requests.map((req) => {
              const contact = req.contact as Record<string, unknown> | null;
              const name = contact
                ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'Sin nombre'
                : 'Desconocido';
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
                        <span>Preferencia: {formatDate(String(req.preferred_date))}</span>
                      ) : null}
                      {req.preferred_time_of_day ? (
                        <span>
                          {' '}
                          ·{' '}
                          {PREFERRED_TIME_LABELS[String(req.preferred_time_of_day)] ??
                            String(req.preferred_time_of_day)}
                        </span>
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
                          onClick={() => openConfirmDialog(req.id as string)}
                        >
                          Confirmar
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-xs text-destructive"
                          onClick={() => updateStatus(req.id as string, 'cancelled')}
                        >
                          Anular
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

    <Dialog open={!!confirmingId} onOpenChange={(open) => !open && setConfirmingId(null)}>
      <DialogContent showCloseButton={true}>
        <DialogHeader>
          <DialogTitle>Confirmar cita</DialogTitle>
          <DialogDescription>
            Indique la fecha y hora reservadas. Es obligatorio para confirmar la solicitud.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 py-2">
          <label htmlFor="confirm-datetime" className="text-sm font-medium">
            Fecha y hora
          </label>
          <Input
            id="confirm-datetime"
            type="datetime-local"
            value={confirmDatetime}
            onChange={(e) => setConfirmDatetime(e.target.value)}
          />
        </div>
        <DialogFooter showCloseButton={false}>
          <Button variant="outline" onClick={() => setConfirmingId(null)}>
            Cancelar
          </Button>
          <Button
            onClick={submitConfirm}
            disabled={!confirmDatetime.trim()}
          >
            Confirmar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
