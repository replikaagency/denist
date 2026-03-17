// =============================================================================
// Supabase Auth middleware — refreshes the session on every request.
// Used by Next.js middleware.ts to keep the auth cookie alive.
// =============================================================================

import { createServerClient } from '@supabase/ssr';
import { type NextRequest, NextResponse } from 'next/server';
import type { User } from '@supabase/supabase-js';

export interface UpdateSessionResult {
  response: NextResponse;
  user: User | null;
}

export async function updateSession(request: NextRequest): Promise<UpdateSessionResult> {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // Refresh the session and surface the user so the middleware can gate routes
  // without a separate cookie-name heuristic.
  const { data: { user } } = await supabase.auth.getUser();

  return { response, user };
}
