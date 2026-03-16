// =============================================================================
// GET  /api/leads — list leads (staff / admin dashboard)
// =============================================================================

import { type NextRequest } from 'next/server';
import { successResponse, errorResponse, handleRouteError } from '@/lib/response';
import { LeadListQuerySchema } from '@/lib/schemas/lead';
import { listLeads } from '@/lib/db/leads';

export async function GET(request: NextRequest) {
  try {
    const searchParams = Object.fromEntries(request.nextUrl.searchParams.entries());
    const parsed = LeadListQuerySchema.safeParse(searchParams);
    if (!parsed.success) {
      return errorResponse('VALIDATION_ERROR', 'Invalid query parameters', 400, parsed.error.issues);
    }

    const { leads, total } = await listLeads(parsed.data);
    return successResponse({ leads, total, ...parsed.data });
  } catch (err) {
    return handleRouteError(err);
  }
}
