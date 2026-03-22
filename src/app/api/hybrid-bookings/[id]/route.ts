// PATCH /api/hybrid-bookings/[id] — staff updates status (operational queue).

import { type NextRequest } from 'next/server';
import { successResponse, errorResponse, handleRouteError } from '@/lib/response';
import { requireStaffAuth } from '@/lib/auth';
import { HybridBookingPatchSchema } from '@/lib/schemas/hybrid-booking';
import { appendConversationEvent } from '@/lib/db/conversation-events';
import { getHybridBookingById, updateHybridBooking } from '@/lib/db/hybrid-bookings';

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

    const before = await getHybridBookingById(id);
    const row = await updateHybridBooking(id, { status: parsed.data.status });
    const conversationId = row.conversation_id ?? before.conversation_id;
    if (conversationId && before.status !== row.status) {
      appendConversationEvent({
        conversationId,
        contactId: row.contact_id,
        leadId: row.lead_id,
        eventType: 'hybrid_status_changed',
        source: 'staff_api',
        metadata: {
          hybrid_booking_id: row.id,
          previous_status: before.status,
          new_status: row.status,
        },
      });
    }
    return successResponse({ hybrid_booking: row });
  } catch (err) {
    return handleRouteError(err);
  }
}
