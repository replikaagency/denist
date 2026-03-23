import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { Card, CardContent } from '@/components/ui/card';
import { HybridAvailabilityList } from './hybrid-availability-list';

export default async function AvailabilityLeadsPage() {
  const supabase = createSupabaseAdminClient();
  const { data: rows, count } = await supabase
    .from('hybrid_bookings')
    .select('*, contact:contacts(*)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .limit(200);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">Disponibilidad</h1>
        <p className="text-sm text-muted-foreground">
          Pacientes que han indicado disponibilidad o prefieren devolución de llamada en lugar de reservar
          online. Use esta lista para llamar a pacientes cuando se libere un hueco en la agenda.
        </p>
      </div>

      <Card className="mb-4 border-border bg-muted/40">
        <CardContent className="space-y-2 px-4 py-3 text-sm leading-relaxed text-muted-foreground">
          <p className="font-medium text-foreground">Cómo usar esta vista</p>
          <p>
            Disponibilidad: pacientes que aún no han cerrado cita, pero han dejado su disponibilidad o
            prefieren que el equipo les contacte.
          </p>
          <p>Citas: solicitudes formales de cita ya registradas.</p>
          <p>
            Un mismo paciente puede aparecer en ambas vistas hasta que el equipo cierre o actualice el caso.
          </p>
        </CardContent>
      </Card>

      <HybridAvailabilityList
        rows={(rows ?? []) as Record<string, unknown>[]}
        total={count ?? 0}
      />
    </div>
  );
}
