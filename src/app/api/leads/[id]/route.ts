// =============================================================================
// GET   /api/leads/[id] — fetch a single lead with contact
// PATCH /api/leads/[id] — update lead (staff CRM actions)
// =============================================================================

import { type NextRequest } from 'next/server';
import { successResponse, errorResponse, handleRouteError } from '@/lib/response';
import { requireStaffAuth } from '@/lib/auth';
import { LeadUpdateSchema } from '@/lib/schemas/lead';
import { getLeadById, updateLead } from '@/lib/db/leads';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requireStaffAuth();
    if (!auth.authenticated) return auth.response;

    const { id } = await params;

    const { data, error } = await createSupabaseAdminClient()
      .from('leads')
      .select('*, contact:contacts(*)')
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;
    if (!data) return errorResponse('NOT_FOUND', `Lead '${id}' not found`, 404);

    return successResponse({ lead: data });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requireStaffAuth();
    if (!auth.authenticated) return auth.response;

    const { id } = await params;

    const body = await request.json();
    const parsed = LeadUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse('VALIDATION_ERROR', 'Invalid request body', 400, parsed.error.issues);
    }

    const lead = await updateLead(id, parsed.data);
    return successResponse({ lead });
  } catch (err) {
    return handleRouteError(err);
  }
}
