// =============================================================================
// Auth helpers for staff route protection
// =============================================================================

import { createSupabaseServerClient } from '@/lib/supabase/server';
import { errorResponse } from '@/lib/response';
import type { NextResponse } from 'next/server';
import type { ApiError } from '@/lib/response';
import type { User } from '@supabase/supabase-js';

export type AuthResult =
  | { authenticated: true; user: User }
  | { authenticated: false; response: NextResponse<ApiError> };

/**
 * Require an authenticated Supabase user for a staff API route.
 * Returns the user if authenticated, or an error response to return immediately.
 */
export async function requireStaffAuth(): Promise<AuthResult> {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    return {
      authenticated: false,
      response: errorResponse('UNAUTHORIZED', 'Authentication required', 401),
    };
  }

  return { authenticated: true, user };
}
