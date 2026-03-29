// =============================================================================
// POST /api/auth/login — Staff login via Supabase Auth (email + password)
// Returns JSON so the client can handle navigation and inline error display.
// Cookie management is tied directly to the response object so that
// Set-Cookie headers are correctly included in the HTTP response.
// =============================================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';

/** Brute-force mitigation — independent of Supabase auth rate limits. */
const LOGIN_ATTEMPTS_PER_IP_PER_15_MIN = 40;

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  const ipLimit = checkRateLimit(`staff-login-ip:${ip}`, LOGIN_ATTEMPTS_PER_IP_PER_15_MIN, 15 * 60_000);
  if (!ipLimit.allowed) {
    return NextResponse.json({ ok: false, error: 'rate_limited' }, { status: 429 });
  }

  const formData = await request.formData();
  const email = formData.get('email') as string;
  const password = formData.get('password') as string;

  if (!email || !password) {
    return NextResponse.json({ ok: false, error: 'invalid_credentials' }, { status: 400 });
  }

  const emailTrim = email.trim();
  if (emailTrim.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrim)) {
    return NextResponse.json({ ok: false, error: 'invalid_credentials' }, { status: 400 });
  }

  // Build the success response first so we can attach cookies to it directly.
  // This is the correct Supabase SSR pattern for Route Handlers — cookies must
  // be set on the same NextResponse object that is returned to the browser.
  const successResponse = NextResponse.json({ ok: true }, { status: 200 });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value, options } of cookiesToSet) {
            successResponse.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const { error } = await supabase.auth.signInWithPassword({ email: emailTrim, password });

  if (error) {
    return NextResponse.json({ ok: false, error: 'invalid_credentials' }, { status: 401 });
  }

  return successResponse;
}
