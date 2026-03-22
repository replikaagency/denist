import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { DashboardShell } from './dashboard-shell';

export const metadata = {
  title: 'Panel de equipo · IA Recepción dental',
};

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login?redirect=/dashboard');
  }

  return <DashboardShell userEmail={user.email ?? 'Equipo'}>{children}</DashboardShell>;
}
