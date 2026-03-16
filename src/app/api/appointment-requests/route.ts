// =============================================================================
// GET  /api/appointment-requests — list requests (staff queue)
// POST /api/appointment-requests — create a request directly (e.g. from a form)
// =============================================================================

import { type NextRequest } from 'next/server';
import { successResponse, errorResponse, handleRouteError } from '@/lib/response';
import { AppointmentListQuerySchema, AppointmentRequestCreateSchema } from '@/lib/schemas/appointment';
import { listAppointmentRequests, createAppointmentRequest } from '@/lib/db/appointments';

export async function GET(request: NextRequest) {
  try {
    const searchParams = Object.fromEntries(request.nextUrl.searchParams.entries());
    const parsed = AppointmentListQuerySchema.safeParse(searchParams);
    if (!parsed.success) {
      return errorResponse('VALIDATION_ERROR', 'Invalid query parameters', 400, parsed.error.issues);
    }

    const { requests, total } = await listAppointmentRequests(parsed.data);
    return successResponse({ requests, total, ...parsed.data });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = AppointmentRequestCreateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse('VALIDATION_ERROR', 'Invalid request body', 400, parsed.error.issues);
    }

    const appt = await createAppointmentRequest(parsed.data);
    return successResponse({ appointment_request: appt }, 201);
  } catch (err) {
    return handleRouteError(err);
  }
}
