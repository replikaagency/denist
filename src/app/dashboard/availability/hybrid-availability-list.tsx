'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const STATUS_COLORS: Record<string, string> = {
  new: 'bg-blue-100 text-blue-800',
  pending_slot: 'bg-amber-100 text-amber-800',
  contacted: 'bg-indigo-100 text-indigo-800',
  booked: 'bg-emerald-100 text-emerald-800',
  closed: 'bg-gray-100 text-gray-600',
};

const STATUS_LABELS: Record<string, string> = {
  new: 'Nuevo',
  pending_slot: 'Pendiente de hueco',
  contacted: 'Contactado',
  booked: 'Reservado',
  closed: 'Cerrado',
};

const MODE_LABELS: Record<string, string> = {
  direct_link: 'Enlace directo',
  callback_request: 'Devolución de llamada',
  availability_capture: 'Disponibilidad',
};

function toTitleCase(str: string) {
  return str.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDateTime(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-ES', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function norm(s: string) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function HybridAvailabilityList({
  rows,
  total,
}: {
  rows: Record<string, unknown>[];
  total: number;
}) {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [dayFilter, setDayFilter] = useState('');
  const [serviceFilter, setServiceFilter] = useState('');
  const [sortNewest, setSortNewest] = useState(true);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    let list = [...rows];
    const dayQ = dayFilter.trim();
    const svcQ = norm(serviceFilter.trim());

    if (statusFilter !== 'all') {
      list = list.filter((r) => r.status === statusFilter);
    }
    if (dayQ) {
      const dq = norm(dayQ);
      list = list.filter((r) => {
        const days = (r.preferred_days as string[]) ?? [];
        return days.some((d) => norm(d).includes(dq) || dq.includes(norm(d)));
      });
    }
    if (svcQ) {
      list = list.filter((r) => norm(String(r.service_interest ?? '')).includes(svcQ));
    }
    list.sort((a, b) => {
      const ta = new Date(String(a.created_at)).getTime();
      const tb = new Date(String(b.created_at)).getTime();
      return sortNewest ? tb - ta : ta - tb;
    });
    return list;
  }, [rows, statusFilter, dayFilter, serviceFilter, sortNewest]);

  async function patchStatus(id: string, status: string) {
    setUpdatingId(id);
    const res = await fetch(`/api/hybrid-bookings/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    setUpdatingId(null);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err?.error?.message ?? 'No se pudo actualizar');
      return;
    }
    router.refresh();
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 border-b py-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {total === 0
              ? 'No hay pacientes pendientes en este momento.'
              : `Mostrando ${filtered.length} de ${total} ${total !== 1 ? 'pacientes' : 'paciente'}`}
          </CardTitle>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-8 w-[140px] text-xs">
              <SelectValue placeholder="Estado" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los estados</SelectItem>
              <SelectItem value="new">Nuevo</SelectItem>
              <SelectItem value="pending_slot">Pendiente de hueco</SelectItem>
              <SelectItem value="contacted">Contactado</SelectItem>
              <SelectItem value="booked">Reservado</SelectItem>
              <SelectItem value="closed">Cerrado</SelectItem>
            </SelectContent>
          </Select>
          <Input
            className="h-8 w-32 text-xs"
            placeholder="Día (ej. lunes)"
            value={dayFilter}
            onChange={(e) => setDayFilter(e.target.value)}
          />
          <Input
            className="h-8 w-36 text-xs"
            placeholder="Motivo contiene…"
            value={serviceFilter}
            onChange={(e) => setServiceFilter(e.target.value)}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => setSortNewest((s) => !s)}
          >
            {sortNewest ? 'Más recientes primero' : 'Más antiguos primero'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {filtered.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-muted-foreground">
            {total === 0
              ? 'Aún no hay pacientes con disponibilidad registrada.'
              : 'No hay pacientes que coincidan con los filtros actuales.'}
          </div>
        ) : (
          <div className="divide-y">
            {filtered.map((row) => {
              const contact = row.contact as Record<string, unknown> | null;
              const name = contact
                ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'Sin nombre'
                : 'Desconocido';
              const phone = contact?.phone ? String(contact.phone) : null;
              const email = contact?.email ? String(contact.email) : null;
              const status = String(row.status);
              const mode = String(row.booking_mode);
              const days = (row.preferred_days as string[]) ?? [];
              const ranges = (row.preferred_time_ranges as string[]) ?? [];
              const notes = row.availability_notes ? String(row.availability_notes) : null;
              const convId = row.conversation_id ? String(row.conversation_id) : null;
              const id = String(row.id);

              return (
                <div key={id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{name}</span>
                      <Badge variant="outline" className={`text-[10px] ${STATUS_COLORS[status] ?? ''}`}>
                        {STATUS_LABELS[status] ?? toTitleCase(status)}
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        {MODE_LABELS[mode] ?? toTitleCase(mode)}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {[phone && `Tel. ${phone}`, email && email].filter(Boolean).join(' · ') || '—'}
                    </div>
                    <div className="text-xs">
                      <span className="font-medium text-foreground">Motivo: </span>
                      {row.service_interest ? String(row.service_interest) : '—'}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground/80">Días: </span>
                      {days.length ? days.join(', ') : '—'}
                      <span className="mx-2">·</span>
                      <span className="font-medium text-foreground/80">Franjas: </span>
                      {ranges.length ? ranges.join('; ') : '—'}
                    </div>
                    {notes ? (
                      <div className="text-xs text-muted-foreground line-clamp-2">
                        <span className="font-medium text-foreground/80">Notas: </span>
                        {notes}
                      </div>
                    ) : null}
                    <div className="text-[11px] text-muted-foreground">
                      Creado {formatDateTime(String(row.created_at))}
                      {convId ? (
                        <>
                          {' · '}
                          <Link
                            href={`/dashboard/conversations/${convId}`}
                            className="text-primary underline-offset-2 hover:underline"
                          >
                            Abrir chat
                          </Link>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1 sm:flex-col sm:items-end">
                    <Select
                      value={status}
                      disabled={updatingId === id}
                      onValueChange={(v) => patchStatus(id, v)}
                    >
                      <SelectTrigger className="h-8 w-[130px] text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="new">Nuevo</SelectItem>
                        <SelectItem value="pending_slot">Pendiente de hueco</SelectItem>
                        <SelectItem value="contacted">Contactado</SelectItem>
                        <SelectItem value="booked">Reservado</SelectItem>
                        <SelectItem value="closed">Cerrado</SelectItem>
                      </SelectContent>
                    </Select>
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
