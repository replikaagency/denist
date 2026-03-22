// PATCH /api/hybrid-bookings/[id] — staff updates status (operational queue).

import { type NextRequest } from 'next/server';
import { successResponse, errorResponse, handleRouteError } from '@/lib/response';
import { requireStaffAuth } from '@/lib/auth';
import { HybridBookingPatchSchema } from '@/lib/schemas/hybrid-booking';
import { updateHybridBooking } from '@/lib/db/hybrid-bookings';

type RouteParams = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requireStaffAuth();
    if (!auth.authenticated) return auth.response;

    const { id } = await params;
    const body = await request.json();
    const parsed = HybridBookingPatchSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse('VALIDATION_ERROR', 'Invalid request body', 400, parsed.error.issues);
    }

    const row = await updateHybridBooking(id, { status: parsed.data.status });
    return successResponse({ hybrid_booking: row });
  } catch (err) {
    return handleRouteError(err);
  }
}
