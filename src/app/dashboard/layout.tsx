import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { DashboardShell } from './dashboard-shell';

export const metadata = {
  title: 'Staff Dashboard · Dental Reception AI',
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

  return <DashboardShell userEmail={user.email ?? 'Staff'}>{children}</DashboardShell>;
}
