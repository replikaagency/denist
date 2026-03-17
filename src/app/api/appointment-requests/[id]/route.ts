// =============================================================================
// GET   /api/appointment-requests/[id]
// PATCH /api/appointment-requests/[id] — staff confirms, cancels, etc.
// =============================================================================

import { type NextRequest } from 'next/server';
import { successResponse, errorResponse, handleRouteError } from '@/lib/response';
import { requireStaffAuth } from '@/lib/auth';
import { AppointmentRequestUpdateSchema } from '@/lib/schemas/appointment';
import { getAppointmentRequestById, updateAppointmentRequest } from '@/lib/db/appointments';
import { advanceLeadStatus } from '@/lib/db/leads';
import { getLeadByContactId } from '@/lib/db/leads';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requireStaffAuth();
    if (!auth.authenticated) return auth.response;

    const { id } = await params;
    const appt = await getAppointmentRequestById(id);
    return successResponse({ appointment_request: appt });
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
    const parsed = AppointmentRequestUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse('VALIDATION_ERROR', 'Invalid request body', 400, parsed.error.issues);
    }

    const appt = await updateAppointmentRequest(id, parsed.data);

    // Cascade status changes to the lead
    if (parsed.data.status === 'confirmed') {
      const lead = await getLeadByContactId(appt.contact_id);
      if (lead) await advanceLeadStatus(appt.contact_id, 'booked');
    }
    if (parsed.data.status === 'cancelled') {
      const lead = await getLeadByContactId(appt.contact_id);
      if (lead && lead.status === 'appointment_requested') {
        await advanceLeadStatus(appt.contact_id, 'contacted');
      }
    }

    return successResponse({ appointment_request: appt });
  } catch (err) {
    return handleRouteError(err);
  }
}
