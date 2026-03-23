// =============================================================================
// GET /api/conversations — list conversations (staff only).
//
// Patient flows create conversations via POST /api/chat/start (not this route).
// =============================================================================

import { type NextRequest } from 'next/server';
import { successResponse, errorResponse, handleRouteError } from '@/lib/response';
import { requireStaffAuth } from '@/lib/auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import { LIMITS } from '@/config/constants';

/**
 * GET /api/conversations — list conversations (staff only)
 */
export async function GET(request: NextRequest) {
  try {
    const ip = getClientIp(request);
    const ipLimit = checkRateLimit(
      `conversations-list-ip:${ip}`,
      LIMITS.CONVERSATIONS_LIST_PER_IP_PER_MINUTE,
      60_000,
    );
    if (!ipLimit.allowed) {
      return errorResponse(
        'RATE_LIMITED',
        'Demasiadas solicitudes desde esta dirección. Por favor, espera un momento.',
        429,
      );
    }

    const auth = await requireStaffAuth();
    if (!auth.authenticated) return auth.response;

    const searchParams = Object.fromEntries(request.nextUrl.searchParams.entries());
    const status = searchParams.status;
    const limit = Math.min(parseInt(searchParams.limit ?? '50', 10) || 50, 100);
    const offset = parseInt(searchParams.offset ?? '0', 10) || 0;

    const supabase = createSupabaseAdminClient();
    let query = supabase
      .from('conversations')
      .select('*, contact:contacts(*)', { count: 'exact' })
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .range(offset, offset + limit - 1);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error, count } = await query;
    if (error) throw error;

    return successResponse({ conversations: data ?? [], total: count ?? 0, limit, offset });
  } catch (err) {
    return handleRouteError(err);
  }
}
