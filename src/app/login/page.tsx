import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { LoginForm } from './login-form';

export const metadata = {
  title: 'Acceso del equipo · IA Recepción dental',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string; error?: string }>;
}) {
  const params = await searchParams;

  // If already logged in, redirect to dashboard
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    redirect(params.redirect ?? '/dashboard');
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-lg bg-primary text-lg font-bold text-primary-foreground">
            DR
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Acceso del equipo</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Panel IA Recepción dental
          </p>
        </div>

        {params.error && (
          <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {params.error === 'invalid_credentials'
              ? 'Correo o contraseña incorrectos. Inténtelo de nuevo.'
              : 'Ha ocurrido un error. Inténtelo de nuevo.'}
          </div>
        )}

        <LoginForm redirectTo={params.redirect} />
      </div>
    </div>
  );
}
