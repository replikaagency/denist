// =============================================================================
// POST /api/auth/login — Staff login via Supabase Auth (email + password)
// =============================================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const email = formData.get('email') as string;
  const password = formData.get('password') as string;
  const redirectTo = (formData.get('redirect') as string) || '/dashboard';

  if (!email || !password) {
    const url = new URL('/login', request.url);
    url.searchParams.set('error', 'invalid_credentials');
    return NextResponse.redirect(url);
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    const url = new URL('/login', request.url);
    url.searchParams.set('error', 'invalid_credentials');
    if (redirectTo !== '/dashboard') {
      url.searchParams.set('redirect', redirectTo);
    }
    return NextResponse.redirect(url);
  }

  return NextResponse.redirect(new URL(redirectTo, request.url));
}
